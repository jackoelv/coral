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
export async function servePlan(planPath, { rpc, allowed, port = 8756, onConfirmed, walletConnectProjectId: rawProjectId = "" } = {}) {
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
  });

  let imtoken = null;
  let closed = false;
  let signing = false;
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
    openImtokenSession({ projectId, chainId: plan.chainId, signer }).then((session) => {
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

  async function gasFor(tx) {
    const estimated = await client.estimateGas({ account: signer, to: tx.to, data: tx.data });
    return gasCeiling(estimated);
  }

  async function track(index, hash) {
    const tx = plan.txs[index];
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
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 600_000 });
      tx.status = receipt.status === "success" ? "success" : "reverted";
      tx.blockNumber = receipt.blockNumber.toString();
      tx.error = tx.status === "reverted" ? `交易回滚：${hash}` : null;
      save();
      console.log(`${tx.label} ${tx.status} ${hash}`);
      if (tx.status === "success" && onConfirmed) await onConfirmed({ plan, index, tx, receipt });
      if (nextPending(plan) === -1) setTimeout(() => finish(plan), 1500);
    } catch (error) {
      tx.status = "failed";
      tx.error = error.message || String(error);
      save();
      console.error(`${tx.label} ${tx.error}`);
    }
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
      if (req.url === "/wc/reconnect") {
        if (!imtoken) return send(409, { error: wcView().message || "imToken 还没准备好" });
        await imtoken.reconnect();
        return send(200, imtoken.snapshot());
      }
      const index = Number(input.index);
      if (index !== nextPending(plan)) return send(409, { error: "只能按顺序签下一笔" });
      const tx = plan.txs[index];
      if (tx.status === "submitted") return send(409, { error: "这笔已提交，等回执" });
      if (req.url === "/estimate") {
        return send(200, { to: tx.to, data: tx.data, gas: await gasFor(tx) });
      }
      if (req.url === "/wc/sign") {
        if (!imtoken) return send(409, { error: wcView().message || "imToken 还没连上" });
        if (signing) return send(409, { error: "上一笔还在等手机确认" });
        const snap = imtoken.snapshot();
        if (!snap.match) return send(409, { error: snap.message || "imToken 当前账户不对" });
        signing = true;
        try {
          const gas = await gasFor(tx);
          const hash = await imtoken.send(buildSendParams({ from: signer, to: tx.to, data: tx.data, gas }));
          tx.status = "submitted";
          tx.hash = hash;
          tx.error = null;
          save();
          track(index, hash);
          return send(200, { ok: true, hash });
        } finally {
          signing = false;
        }
      }
      if (req.url === "/submitted") {
        if (!/^0x[0-9a-fA-F]{64}$/.test(input.hash || "")) return send(400, { error: "交易哈希格式不对" });
        tx.status = "submitted";
        tx.hash = input.hash;
        tx.error = null;
        save();
        track(index, input.hash);
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
  if (nextPending(plan) !== -1) openPage(pageUrl);
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
<div id="wallet" class="card"><b>或使用这台电脑上的浏览器插件</b><p class="muted">插件里的私钥在这台电脑上。Publisher 请用上面的 imToken。</p><button id="connect">连接插件</button> <span id="who" class="muted"></span></div>
<div id="txs"></div>
<script>
const TOKEN=${JSON.stringify(token)};
let plan=null, provider=null, busy=false, wc={enabled:false,status:"off",match:false,account:null,message:"",qr:null};
const $=id=>document.getElementById(id);
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function pick(){
  const w=window;
  if(w.binancew3w&&w.binancew3w.ethereum) return w.binancew3w.ethereum;
  const list=(w.ethereum&&w.ethereum.providers)||[];
  const bn=list.find(p=>p.isBinance||p.isBinanceWallet);
  if(bn) return bn;
  if(w.ethereum&&(w.ethereum.isBinance||w.ethereum.isBinanceWallet)) return w.ethereum;
  if(w.BinanceChain) return w.BinanceChain;
  return w.ethereum||null;
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
    const st=t.status==="success"?'<span class=ok>已成功</span>':t.status==="submitted"?"等待回执…":(t.status==="reverted"||t.status==="failed")?'<span class=bad>'+esc(t.error||t.status)+"</span>":"待签";
    const link=t.hash?'<br>哈希 <a target=_blank href="'+plan.explorer+"/tx/"+t.hash+'"><code>'+esc(t.hash)+"</code></a>":"";
    const args=t.args.map(a=>'<tr><td class=muted>'+esc(a.name)+" ("+esc(a.type)+')</td><td><code>'+esc(JSON.stringify(a.value))+"</code></td></tr>").join("");
    const mine=t.index===plan.next&&t.status!=="submitted";
    const im=mine&&wc.match?'<button onclick="signImtoken('+t.index+')" '+(busy?"disabled":"")+">用 imToken 签这一笔</button> ":"";
    const ext=mine?'<button class=secondary onclick="signExtension('+t.index+')" '+(busy?"disabled":"")+">用浏览器插件签</button>":"";
    return '<div class=card><b>'+(t.index+1)+". "+esc(t.label)+"</b> "+st+"<br>"+esc(t.contract)+' <code>'+esc(t.to)+"</code><br>函数 <code>"+esc(t.functionName)+"</code><table>"+args+"</table>"+im+ext+link+"</div>";
  }).join("");
}
async function reconnectWc(){
  try{ await post("/wc/reconnect",{}); }catch(e){ alert(e.message||e); }
  await load();
}
async function ensureAccountAndChain(){
  provider=provider||pick();
  if(!provider) throw new Error("没有检测到钱包插件");
  const accounts=await provider.request({method:"eth_requestAccounts"});
  const active=(accounts&&accounts[0])||"";
  $("who").textContent="钱包当前账户 "+active;
  if(active.toLowerCase()!==plan.signer.toLowerCase()) throw new Error("钱包当前账户是 "+active+"，请在插件里切换到 "+plan.signer+" 后重试");
  let cid=await provider.request({method:"eth_chainId"});
  if(String(cid).toLowerCase()!==plan.chainHex){
    await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:plan.chainHex}]});
    cid=await provider.request({method:"eth_chainId"});
    if(String(cid).toLowerCase()!==plan.chainHex) throw new Error("钱包没有切到链 "+plan.chainId);
  }
  return active;
}
$("connect").onclick=async()=>{ try{ await ensureAccountAndChain(); $("who").className="ok"; }catch(e){ $("who").className="bad"; $("who").textContent=e.message||e; } };
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
    const hash=await provider.request({method:"eth_sendTransaction",params:[{from,to:pre.to,data:pre.data,value:"0x0",gas:pre.gas}]});
    await post("/submitted",{index,hash});
  }catch(e){ alert(e.message||e); }
  busy=false; await load();
}
setInterval(load,2000); load();
</script></body></html>`;
}
