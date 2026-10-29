import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createPublicClient, getAddress, http } from "viem";
import { openImtokenSession } from "./imtoken-session.mjs";
import { CHAIN_HEX, checkPlan, nextPending, readPlan, writePlan } from "./sign-plan.mjs";
import { buildSendParams, gasCeiling, walletConnectProjectId } from "./sign-wallet.mjs";

const EXPLORER = { 56: "https://bscscan.com", 97: "https://testnet.bscscan.com" };

/**
 * Serves one plan on 127.0.0.1. The phone path is imToken over WalletConnect.
 * A browser extension still works, but that key lives on this computer.
 * Rules from the chain bug log: no viem writeContract, the first account must be
 * the planned signer, chain must match, gas comes from an HTTP RPC estimate
 * times 1.5, and only a successful receipt counts.
 * Resolves once every tx in the plan has a successful receipt.
 */
export async function servePlan(planPath, { rpc, allowed, port = 8756, onConfirmed, beforeSend, walletConnectProjectId: rawProjectId = "", openSession = openImtokenSession, openBrowser = true } = {}) {
  let plan = readPlan(planPath);
  const client = createPublicClient({ transport: http(rpc, { retryCount: 2, timeout: 30_000 }) });
  if ((await client.getChainId()) !== plan.chainId) throw new Error(`RPC 不是计划要求的 chainId ${plan.chainId}`);
  checkPlan(plan, allowed);
  const token = randomBytes(24).toString("hex");
  const signer = getAddress(plan.signer);
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  let projectId = null;
  let projectError = null;
  try {
    projectId = walletConnectProjectId(rawProjectId);
  } catch (error) {
    projectError = error.message;
  }

  const save = () => writePlan(planPath, plan);
  const view = () => ({
    chainId: plan.chainId,
    chainHex: CHAIN_HEX[plan.chainId],
    signer,
    signerRole: plan.signerRole,
    purpose: plan.purpose,
    explorer: EXPLORER[plan.chainId],
    next: nextPending(plan),
    txs: checkPlan(plan, allowed).map((row, i) => ({ ...row, error: plan.txs[i].error || null })),
    canReconcile: Boolean(beforeSend),
    waiting: pending ? { index: pending.index, seconds: Math.round((Date.now() - pending.startedAt) / 1000) } : null,
  });

  const pendingNonce = () => client.getTransactionCount({ address: signer, blockTag: "pending" });

  function record(index, hash) {
    const tx = plan.txs[index];
    tx.status = "submitted";
    tx.hash = hash;
    tx.error = null;
    save();
    track(index, hash);
  }

  function abandon(reason) {
    const entry = pending;
    entry.abandoned = true;
    abandoned = entry;
    pending = null;
    console.log(reason);
    entry.cancel(new Error(reason));
  }

  function lateResult(entry, hash) {
    const tx = plan.txs[entry.index];
    if (tx.hash && tx.hash.toLowerCase() === hash.toLowerCase()) return;
    if (tx.status === "submitted" || tx.status === "success") {
      console.error(`已放弃的那次请求后来也返回了哈希 ${hash}，而这笔已经用 ${tx.hash} 提交。去浏览器核对签名账户是否发出了两笔。`);
      return;
    }
    console.log(`已放弃的那次请求后来返回了哈希 ${hash}，按这笔交易继续跟踪。`);
    record(entry.index, hash);
  }

  let imtoken = null;
  let closed = false;
  // A phone that lost its network never answers; the operator must be able to give up and resend.
  let pending = null;
  let abandoned = null;
  const wcFallback = {
    enabled: Boolean(projectId) && !projectError,
    status: projectError ? "error" : projectId ? "starting" : "off",
    match: false,
    account: null,
    qr: null,
    message: projectError || (projectId ? "正在生成二维码…" : "还没配置 WALLETCONNECT_PROJECT_ID。在 https://cloud.reown.com 创建一个项目，把 Project ID 填进 .env.mainnet 后重新运行。这不是私钥。"),
    reconnect: false,
  };
  const wcView = () => (imtoken ? imtoken.snapshot() : wcFallback);

  if (projectId) {
    openSession({ projectId, chainId: plan.chainId, signer }).then((session) => {
      if (closed) {
        session.close().catch(() => {});
        return;
      }
      imtoken = session;
      console.log("imToken 二维码已放在签名页上。");
    }).catch((error) => {
      wcFallback.status = "error";
      wcFallback.enabled = true;
      wcFallback.message = hideProjectId(error?.message || String(error), projectId);
      console.error(`imToken 连接准备失败：${wcFallback.message}`);
    });
  }

  let preparing = false;
  async function prepareSend(index) {
    if (preparing) throw new Error("签名前检查进行中，请勿重复点击");
    preparing = true;
    try {
      const tx = plan.txs[index];
      const gas = await gasFor(tx);
      const extra = beforeSend ? await beforeSend({ plan, index, tx, client }) : {};
      save();
      return { to: tx.to, data: tx.data, gas, ...extra };
    } finally { preparing = false; }
  }

  async function gasFor(tx) {
    const estimated = await client.estimateGas({ account: signer, to: tx.to, data: tx.data });
    return gasCeiling(estimated);
  }

  const tracking = new Set();
  async function track(index, hash) {
    if (tracking.has(index)) return;
    tracking.add(index);
    try { await trackOnce(index, hash); } finally { tracking.delete(index); }
  }
  async function trackOnce(index, hash) {
    const tx = plan.txs[index];
    let receipt;
    try {
      let live = null;
      for (let i = 0; i < 120 && !live; i++) {
        live = await client.getTransaction({ hash }).catch(() => null);
        if (!live) await new Promise((r) => setTimeout(r, 3000));
      }
      if (!live) throw new Error("6 分钟内 RPC 查不到这笔交易，可能没有广播");
      if (getAddress(live.from) !== signer) throw new Error(`实际签名账户是 ${live.from}，不是 ${signer}`);
      if (!live.to || getAddress(live.to) !== getAddress(tx.to) || live.input.toLowerCase() !== tx.data.toLowerCase()) {
        throw new Error("链上交易的目标或 calldata 和计划不一致");
      }
      receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 600_000 });
      tx.status = receipt.status === "success" ? "success" : "reverted";
      tx.blockNumber = receipt.blockNumber.toString();
      tx.error = tx.status === "reverted" ? `交易回滚：${hash}` : null;
      save();
      console.log(`${tx.label} ${tx.status} ${hash}`);
    } catch (error) {
      tx.status = beforeSend && tx.hash ? "submitted" : "failed";
      tx.error = error.message || String(error);
      save();
      console.error(`${tx.label} ${tx.error}`);
      return;
    }
    if (tx.status === "success" && onConfirmed) {
      try {
        await onConfirmed({ plan, index, tx, receipt });
        save();
      } catch (error) {
        if (beforeSend) { tx.status = "submitted"; tx.error = `已上链，待登记：${error.message}`; save(); }
        console.error(`${tx.label} 链上已成功（${hash}），但后续登记失败：${error.message || error}。用原来的 --resume 打开同一份计划补登记，不要重新签。`);
      }
    }
    if (nextPending(plan) === -1) setTimeout(() => finish(plan), 1500);
  }

  for (const [index, tx] of plan.txs.entries()) if (tx.status === "submitted" && tx.hash) track(index, tx.hash);

  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: "只接受 127.0.0.1" });
    try {
      if (req.method === "GET" && req.url === "/") return send(200, page(token), "text/html; charset=utf-8");
      if (req.method === "GET" && req.url === "/plan") return send(200, view());
      if (req.method === "GET" && req.url === "/wc") return send(200, wcView());
      if (req.method !== "POST") return send(404, { error: "not found" });
      if (req.headers["x-sign-token"] !== token) return send(403, { error: "token 不对" });
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body || "{}");
      if (req.url === "/wc/abandon") {
        if (!pending) return send(409, { error: "现在没有在等手机的请求" });
        abandon("已放弃这次请求。手机上如果还弹出这笔，请点拒绝。");
        return send(200, { ok: true });
      }
      if (req.url === "/wc/reconnect") {
        if (!imtoken) return send(409, { error: wcView().message || "imToken 还没准备好" });
        if (pending) abandon("已重新连接，原来那次请求作废。手机上如果还弹出那笔，请点拒绝。");
        await imtoken.reconnect();
        return send(200, imtoken.snapshot());
      }
      const index = Number(input.index);
      if (index !== nextPending(plan)) return send(409, { error: "只能按顺序签下一笔" });
      const tx = plan.txs[index];
      if (req.url === "/reconcile" && beforeSend && tx.hash) {
        track(index, tx.hash);
        return send(200, { ok: true });
      }
      if (tx.status === "submitted") return send(409, { error: "这笔已提交，等回执" });
      if (req.url === "/estimate") {
        return send(200, await prepareSend(index));
      }
      if (req.url === "/wc/sign") {
        if (!imtoken) return send(409, { error: wcView().message || "imToken 还没连上" });
        if (pending) {
          const seconds = Math.round((Date.now() - pending.startedAt) / 1000);
          return send(409, { error: `上一笔已等手机 ${seconds} 秒。手机没弹出确认的话，点“放弃这次请求”再重签。` });
        }
        const snap = imtoken.snapshot();
        if (!snap.match) return send(409, { error: snap.message || "imToken 当前账户不对" });
        const nonce = await pendingNonce();
        if (abandoned && nonce > abandoned.nonce) {
          return send(409, {
            error: `签名账户的 nonce 从 ${abandoned.nonce} 变成了 ${nonce}，被放弃的那次请求可能已经发出。先在 ${EXPLORER[plan.chainId]}/address/${signer} 查最新交易；是这笔就把哈希填到下面，不要重签。`,
          });
        }
        let cancel;
        const entry = { index, nonce, startedAt: Date.now() };
        entry.cancelled = new Promise((_, reject) => (cancel = reject));
        entry.cancel = cancel;
        pending = entry;
        try {
          const prepared = await prepareSend(index);
          const request = imtoken.send({ ...buildSendParams({ from: signer, to: tx.to, data: tx.data, gas: prepared.gas }), ...(prepared.nonce ? { nonce: prepared.nonce } : {}) });
          request.then((hash) => entry.abandoned && lateResult(entry, hash), () => {});
          const hash = await Promise.race([request, entry.cancelled]);
          abandoned = null;
          record(index, hash);
          return send(200, { ok: true, hash });
        } finally {
          if (pending === entry) pending = null;
        }
      }
      if (req.url === "/submitted") {
        if (!/^0x[0-9a-fA-F]{64}$/.test(input.hash || "")) return send(400, { error: "交易哈希格式不对" });
        if (pending) abandon("已手动填了哈希，原来那次请求作废。");
        abandoned = null;
        record(index, input.hash);
        return send(200, { ok: true });
      }
      return send(404, { error: "not found" });
    } catch (error) {
      return send(400, { error: hideProjectId(error.shortMessage || error.message || String(error), projectId) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const pageUrl = `http://127.0.0.1:${port}/`;
  console.log(`签名页 ${pageUrl}`);
  console.log(`签名人 ${signer}（${plan.signerRole}）。`);
  if (projectId) console.log("用手机 imToken 扫签名页上的二维码。手机当前账户必须是上面的地址，网络必须是这条链。私钥不要导入这台电脑。");
  else console.log(wcFallback.message);
  console.log("浏览器插件仍可签名，但插件里的私钥在这台电脑上。");
  if (openBrowser && nextPending(plan) !== -1) openPage(pageUrl);
  if (nextPending(plan) === -1) finish(plan);
  process.once("SIGINT", () => {
    console.log("\n已停下。若交易还没成功，用原来的 --resume 打开同一份计划，不要重新生成。");
    closed = true;
    server.close();
    Promise.resolve(imtoken?.close()).finally(() => process.exit(130));
  });
  const result = await done;
  closed = true;
  server.close();
  await imtoken?.close().catch(() => {});
  return result;
}

function hideProjectId(text, projectId) {
  return projectId ? String(text).split(projectId).join("[WALLETCONNECT_PROJECT_ID]") : String(text);
}

function openPage(url) {
  if (process.platform !== "darwin") return;
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export function renderSignPage(token) {
  return page(token);
}

function page(token) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Nemo 签名页</title>
<style>
html{color-scheme:light}
body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:920px;margin:24px auto;padding:0 16px;background:#fff;color:#07363F}
.card{border:1px solid #cfe;border-radius:10px;padding:12px 16px;margin:12px 0}
.ok{color:#08804a}.bad{color:#b3261e}.muted{color:#678}
button{font-size:15px;padding:8px 16px;border-radius:8px;border:0;background:#00a8ab;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#07363F;border:1px solid #9cc}
button:disabled{background:#9bb;color:#fff}
#qr{display:block;width:280px;height:280px;background:#fff;padding:8px;border-radius:8px;border:1px solid #cfe}
code{word-break:break-all}
td{padding:2px 8px;vertical-align:top}
</style></head><body>
<h2>链上交易签名</h2>
<div id="head" class="card"></div>
<div id="imtoken" class="card"></div>
<div id="wallet" class="card"><b>或使用这台电脑上的币安钱包、OKX 钱包</b><p class="muted">插件里的私钥在这台电脑上。先点下面的按钮连接。钱包当前账户必须是上面的签名人；币安和 OKX 都按当前账户签名。</p><button type="button" id="connect-binance">连接币安钱包</button> <button type="button" class="secondary" id="connect-okx">连接 OKX 钱包</button> <span id="who" class="muted"></span></div>
<div id="txs"></div>
<div id="manual" class="card"><b>手机已经发出交易、页面没收到？</b><p class="muted">在浏览器里查签名账户的最新交易，把哈希填这里。脚本会核对发送账户、目标合约和 calldata，不对就不算。</p><input id="hash" size="70" placeholder="0x…"> <button class="secondary" id="useHash">登记这个哈希</button></div>
<script>
const TOKEN=${JSON.stringify(token)};
let plan=null, provider=null, walletName="", busy=false, wc={enabled:false,status:"off",match:false,account:null,message:"",qr:null};
const $=id=>document.getElementById(id);
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
const announced=[];
window.addEventListener("eip6963:announceProvider",function(event){
  const detail=event.detail;
  if(detail&&detail.provider&&typeof detail.provider.request==="function") announced.push(detail);
});
try{window.dispatchEvent(new Event("eip6963:requestProvider"));}catch(e){}
function walletKind(detail){
  const info=detail.info||{};
  const text=String((info.rdns||"")+" "+(info.name||"")).toLowerCase();
  const p=detail.provider||{};
  if(text.indexOf("okx")>=0||text.indexOf("okex")>=0||p.isOkxWallet||p.isOKExWallet) return "okx";
  if(text.indexOf("binance")>=0||p.isBinance||p.isBinanceWallet) return "binance";
  return "";
}
function addWallet(list,kind,name,p){
  if(!p||typeof p.request!=="function") return;
  if(list.some(function(x){return x.kind===kind||x.provider===p;})) return;
  list.push({kind:kind,name:name,provider:p});
}
function wallets(){
  const w=window, list=[];
  announced.forEach(function(detail){
    const kind=walletKind(detail);
    if(kind==="okx") addWallet(list,"okx","OKX 钱包",detail.provider);
    if(kind==="binance") addWallet(list,"binance","币安钱包",detail.provider);
  });
  addWallet(list,"okx","OKX 钱包",w.okxwallet);
  const w3w=w.binancew3w;
  if(w3w) addWallet(list,"binance","币安钱包",w3w.ethereum||(w3w.providers&&w3w.providers.ethereum)||(typeof w3w.request==="function"?w3w:null));
  addWallet(list,"binance","币安钱包",w.BinanceChain);
  const multi=(w.ethereum&&w.ethereum.providers)||[];
  multi.forEach(function(p){
    if(p.isOkxWallet||p.isOKExWallet) addWallet(list,"okx","OKX 钱包",p);
    else if(p.isBinance||p.isBinanceWallet) addWallet(list,"binance","币安钱包",p);
  });
  const eth=w.ethereum;
  if(eth){
    if(eth.isOkxWallet||eth.isOKExWallet) addWallet(list,"okx","OKX 钱包",eth);
    if(eth.isBinance||eth.isBinanceWallet) addWallet(list,"binance","币安钱包",eth);
  }
  return list;
}
function selectWallet(kind){
  const found=wallets().find(function(x){return x.kind===kind;});
  if(!found) throw new Error(kind==="okx"?"没有检测到 OKX 钱包。请确认 Chrome 已启用 OKX 钱包，然后刷新本页。":"没有检测到币安钱包。请确认 Chrome 已启用币安钱包，然后刷新本页。");
  provider=found.provider;
  walletName=found.name;
}
async function post(path,body){
  const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-sign-token":TOKEN},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok) throw new Error(j.error||r.status); return j;
}
async function load(){
  plan=await (await fetch("/plan")).json();
  try{ wc=await (await fetch("/wc")).json(); }catch(e){ wc.message=e.message||String(e); }
  render();
}
function renderImtoken(){
  const box=$("imtoken");
  const title="<b>用手机 imToken 签名</b>";
  if(!wc.enabled){
    box.innerHTML=title+"<p>"+esc(wc.message)+"</p>";
    return;
  }
  const qr=wc.qr&&String(wc.qr).indexOf("data:image/png;base64,")===0?'<img id="qr" alt="imToken 扫码" src="'+wc.qr+'">':"";
  const who=wc.account?"<br>手机当前账户 <code>"+esc(wc.account)+"</code>":"";
  const cls=wc.match?"ok":(wc.status==="error"?"bad":"muted");
  const again=wc.reconnect?' <button type="button" id="reconnect">重新连接</button>':"";
  box.innerHTML=title+who+'<p class="'+cls+'">'+esc(wc.message||"")+"</p>"+qr+"<p>"+again+"</p>";
  const btn=$("reconnect");
  if(btn) btn.onclick=reconnectWc;
}
function render(){
  $("head").innerHTML="<b>"+esc(plan.purpose)+"</b><br>签名人（"+esc(plan.signerRole)+'）：<code>'+esc(plan.signer)+"</code><br>链："+plan.chainId;
  renderImtoken();
  $("txs").innerHTML=plan.txs.map(t=>{
    const st=t.status==="success"?'<span class=ok>已成功</span>':t.status==="submitted"?(t.error?'<span class=bad>'+esc(t.error)+"</span>":"等待回执…"):(t.status==="reverted"||t.status==="failed")?'<span class=bad>'+esc(t.error||t.status)+"</span>":"待签";
    const link=t.hash?'<br>哈希 <a target=_blank href="'+plan.explorer+"/tx/"+t.hash+'"><code>'+esc(t.hash)+"</code></a>":"";
    const args=t.args.map(a=>'<tr><td class=muted>'+esc(a.name)+" ("+esc(a.type)+')</td><td><code>'+esc(JSON.stringify(a.value))+"</code></td></tr>").join("");
    const repair=plan.canReconcile&&t.index===plan.next&&t.hash&&t.status==="submitted"?'<button class=secondary onclick="reconcile('+t.index+')">重新核验 / 补登记</button>':"";
    const mine=t.index===plan.next&&t.status!=="submitted";
    const wait=plan.waiting&&plan.waiting.index===t.index?'<p>已等手机 '+plan.waiting.seconds+' 秒。手机没弹出确认（比如断网），点 <button class=secondary onclick="abandonWc()">放弃这次请求</button>，再重签。</p>':"";
    const off=busy||plan.waiting?"disabled":"";
    const im=mine&&wc.match?'<button onclick="signImtoken('+t.index+')" '+off+">用 imToken 签这一笔</button> ":"";
    const ext=mine?'<button class=secondary onclick="signExtension('+t.index+')" '+off+">用已连接的钱包签</button>":"";
    return '<div class=card><b>'+(t.index+1)+". "+esc(t.label)+"</b> "+st+"<br>"+esc(t.contract)+' <code>'+esc(t.to)+"</code><br>函数 <code>"+esc(t.functionName)+"</code><table>"+args+"</table>"+wait+repair+im+ext+link+"</div>";
  }).join("");
}
async function reconcile(index){
  try{ await post("/reconcile",{index}); }catch(e){ alert(e.message||e); }
  await load();
}
async function abandonWc(){
  try{ await post("/wc/abandon",{}); }catch(e){ alert(e.message||e); }
  await load();
}
$("useHash").onclick=async()=>{
  const hash=$("hash").value.trim();
  if(!plan||plan.next<0) return alert("没有待签的交易");
  try{ await post("/submitted",{index:plan.next,hash}); $("hash").value=""; }catch(e){ alert(e.message||e); }
  await load();
};
async function reconnectWc(){
  try{ await post("/wc/reconnect",{}); }catch(e){ alert(e.message||e); }
  await load();
}
async function ensureAccountAndChain(){
  if(!provider) throw new Error("请先连接币安钱包或 OKX 钱包");
  const accounts=await provider.request({method:"eth_requestAccounts"});
  const active=(accounts&&accounts[0])||"";
  $("who").textContent=walletName+" 当前账户 "+active;
  if(active.toLowerCase()!==plan.signer.toLowerCase()) throw new Error(walletName+" 当前账户是 "+active+"，请在这个钱包里切换到 "+plan.signer+" 后重试");
  let cid=await provider.request({method:"eth_chainId"});
  if(String(cid).toLowerCase()!==plan.chainHex){
    await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:plan.chainHex}]});
    cid=await provider.request({method:"eth_chainId"});
    if(String(cid).toLowerCase()!==plan.chainHex) throw new Error("钱包没有切到链 "+plan.chainId);
  }
  return active;
}
async function connectKind(kind){
  try{
    if(!wallets().some(function(x){return x.kind===kind;})) await new Promise(function(r){setTimeout(r,400);});
    selectWallet(kind);
    await ensureAccountAndChain();
    $("who").className="ok";
  }catch(e){ $("who").className="bad"; $("who").textContent=e.message||e; }
}
$("connect-binance").onclick=function(){ connectKind("binance"); };
$("connect-okx").onclick=function(){ connectKind("okx"); };
async function signImtoken(index){
  if(busy) return; busy=true; render();
  try{ await post("/wc/sign",{index}); }
  catch(e){ alert(e.message||e); }
  busy=false; await load();
}
async function signExtension(index){
  if(busy) return; busy=true; render();
  try{
    const from=await ensureAccountAndChain();
    const pre=await post("/estimate",{index});
    const hash=await provider.request({method:"eth_sendTransaction",params:[{from,to:pre.to,data:pre.data,value:"0x0",gas:pre.gas,...(pre.nonce?{nonce:pre.nonce}:{})}]});
    await post("/submitted",{index,hash});
  }catch(e){ alert(e.message||e); }
  busy=false; await load();
}
setInterval(load,2000); load();
</script></body></html>`;
}
