import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createPublicClient, getAddress, http, parseTransaction, recoverTransactionAddress } from "viem";
import { imkeyBrowserBundle } from "./imkey-bundle.mjs";
import { gasCeiling } from "./sign-wallet.mjs";

const EXPLORER = { 56: "https://bscscan.com", 97: "https://testnet.bscscan.com" };

/**
 * The signed transaction must be the legacy call we just showed the operator.
 * imKey signs on the device. This only checks the bytes before broadcast.
 */
export async function assertSignedCall(raw, expected) {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error("签名结果不是十六进制交易");
  let tx;
  try {
    tx = parseTransaction(raw);
  } catch {
    throw new Error("签出来的不是一笔可解析的交易");
  }
  if (tx.type !== "legacy") throw new Error("imKey 应签传统交易，签出来的不是");
  if (tx.chainId !== expected.chainId) throw new Error(`签名链是 ${tx.chainId}，不是 ${expected.chainId}`);
  if (!tx.to || getAddress(tx.to) !== getAddress(expected.to)) throw new Error("签名交易的合约地址和页面不一致");
  if ((tx.data || "0x").toLowerCase() !== expected.data.toLowerCase()) throw new Error("签名交易的 calldata 和页面不一致");
  if ((tx.value ?? 0n) !== 0n) throw new Error("签名交易带了 BNB 金额");
  if (BigInt(tx.nonce) !== BigInt(expected.nonce)) throw new Error(`签名 nonce 是 ${tx.nonce}，准备时是 ${expected.nonce}`);
  if (BigInt(tx.gas) !== BigInt(expected.gas)) throw new Error("签名的 gas 上限和准备时不一致");
  if (BigInt(tx.gasPrice) !== BigInt(expected.gasPrice)) throw new Error("签名的 gas 价格和准备时不一致");
  const signer = await recoverTransactionAddress({ serializedTransaction: raw });
  if (getAddress(signer) !== getAddress(expected.from)) {
    throw new Error(`这笔签名来自 ${signer}，不是 Owner ${expected.from}`);
  }
  return tx;
}

export function renderImkeyPage(token) {
  return page(token);
}

/**
 * Local Chrome page. WebUSB talks to imKey; the private key stays on the device.
 * The page listens on 127.0.0.1 only. Calldata is built in Node, never typed in.
 */
export async function serveImkey({
  rpc,
  chainId,
  owner,
  token,
  purpose,
  call,
  port = 8757,
  openBrowser = true,
  confirmations = 3,
  bundle = imkeyBrowserBundle,
  keepAlive = true,
}) {
  const signer = getAddress(owner);
  const target = getAddress(token);
  const client = createPublicClient({ transport: http(rpc, { retryCount: 2, timeout: 30_000 }) });
  if ((await client.getChainId()) !== chainId) throw new Error(`RPC 不是 chainId ${chainId}`);
  const js = await bundle();
  const session = randomBytes(24).toString("hex");
  let matched = false;
  let prepared = null;
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  async function prepare() {
    const nonce = await client.getTransactionCount({ address: signer, blockTag: "pending" });
    const gasPrice = await client.getGasPrice();
    const estimated = await client.estimateGas({ account: signer, to: target, data: call.data });
    const gas = BigInt(gasCeiling(estimated));
    prepared = { from: signer, to: target, data: call.data, nonce, gas, gasPrice, chainId };
    return {
      to: target,
      data: call.data,
      // "0" makes imKey's preview treat an unknown contract as an ERC-20 and throw.
      value: "0x0",
      nonce: nonce.toString(),
      gasPrice: gasPrice.toString(),
      gasLimit: gas.toString(),
      chainId,
      symbol: chainId === 56 ? "BNB" : "tBNB",
      decimal: "18",
    };
  }

  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: "只接受 127.0.0.1" });
    try {
      if (req.method === "GET" && req.url === "/") return send(200, page(session), "text/html; charset=utf-8");
      if (req.method === "GET" && req.url === "/imkey.js") {
        return send(200, js, "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && req.url === "/job") {
        return send(200, {
          purpose,
          owner: signer,
          token: target,
          chainId,
          explorer: EXPLORER[chainId] || "",
          functionName: call.functionName,
          args: call.args,
          matched,
        });
      }
      if (req.method !== "POST") return send(404, { error: "not found" });
      if (req.headers["x-sign-token"] !== session) return send(403, { error: "token 不对" });
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body || "{}");
      if (req.url === "/account") {
        const address = getAddress(input.address || "");
        matched = address === signer;
        if (!matched) return send(409, { error: `imKey 地址是 ${address}，链上 Owner 是 ${signer}` });
        return send(200, { ok: true, address });
      }
      if (req.url === "/prepare") {
        if (!matched) return send(409, { error: "先连接 imKey，并确认它就是 Owner" });
        return send(200, await prepare());
      }
      if (req.url === "/signed") {
        if (!prepared) return send(409, { error: "还没有准备好这笔交易" });
        const expected = prepared;
        await assertSignedCall(input.raw, expected);
        const hash = await client.sendRawTransaction({ serializedTransaction: input.raw });
        console.log(`已广播 ${hash}`);
        let receipt;
        try {
          receipt = await client.waitForTransactionReceipt({ hash, confirmations, timeout: 600_000 });
        } catch (error) {
          const message = `已广播 ${hash}，回执还没到：${error.message || error}。不要重签。`;
          send(400, { error: message });
          fail(new Error(message));
          return;
        }
        const live = await client.getTransaction({ hash });
        if (!live || getAddress(live.from) !== signer || getAddress(live.to) !== target) {
          const message = `链上交易 ${hash} 的发送方或合约和准备的不一致`;
          send(400, { error: message });
          fail(new Error(message));
          return;
        }
        if (live.input.toLowerCase() !== call.data.toLowerCase()) {
          const message = `链上交易 ${hash} 的 calldata 和准备的不一致`;
          send(400, { error: message });
          fail(new Error(message));
          return;
        }
        if (receipt.status !== "success") {
          const message = `交易回滚：${hash}`;
          send(400, { error: message });
          fail(new Error(message));
          return;
        }
        send(200, { ok: true, hash });
        finish({ hash });
        return;
      }
      return send(404, { error: "not found" });
    } catch (error) {
      return send(400, { error: error.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  if (!keepAlive) server.unref();
  const pageUrl = `http://127.0.0.1:${port}/`;
  console.log(`imKey 签名页 ${pageUrl}`);
  console.log(`用 Chrome 打开。数据线连接 imKey。Owner 必须是设备的第一个 EVM 地址 ${signer}。`);
  if (openBrowser) openPage(pageUrl);
  process.once("SIGINT", () => {
    console.log("\n已停下。如果设备上还显示确认，请按取消。");
    server.close();
    process.exit(130);
  });
  try {
    return await done;
  } finally {
    server.close();
  }
}

function openPage(url) {
  if (process.platform !== "darwin") return;
  const child = spawn("open", ["-a", "Google Chrome", url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function page(token) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>imKey 签名</title>
<style>
html{color-scheme:light}
body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:760px;margin:24px auto;padding:0 16px;background:#fff;color:#07363F}
.card{border:1px solid #cfe;border-radius:10px;padding:12px 16px;margin:12px 0}
.ok{color:#08804a}.bad{color:#b3261e}.muted{color:#678}
button{font-size:15px;padding:8px 16px;border-radius:8px;border:0;background:#00a8ab;color:#fff;cursor:pointer}
button:disabled{background:#9bb}
code{word-break:break-all}
td{padding:2px 8px;vertical-align:top}
</style></head><body>
<h2>imKey 离线签名</h2>
<div id="job" class="card">正在读取这笔交易…</div>
<div class="card">
<p>用数据线把 imKey 接到这台电脑，然后点下面的按钮。请用 Chrome。私钥不会离开 imKey。</p>
<p class="muted">设备屏幕上的收款地址是 CKEY 合约，金额是 0。铸造给谁、加的是哪个白名单，以本页为准。手续费从 imKey 扣 BNB，设备上可能标成 ETH。</p>
<button id="connect">连接 imKey</button>
<p id="who" class="muted"></p>
<button id="sign" disabled>在 imKey 上确认并发送</button>
<p id="result"></p>
</div>
<script src="/imkey.js"></script>
<script>
const TOKEN=${JSON.stringify(token)};
const $=id=>document.getElementById(id);
let job=null, busy=false;
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function post(path,body){
  const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-sign-token":TOKEN},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok) throw new Error(j.error||r.status); return j;
}
function render(){
  const args=job.args.map(a=>'<tr><td class=muted>'+esc(a.name)+' ('+esc(a.type)+')</td><td><code>'+esc(a.value)+'</code></td></tr>').join("");
  $("job").innerHTML="<b>"+esc(job.purpose)+"</b><br>Owner <code>"+esc(job.owner)+"</code><br>CKEY <code>"+esc(job.token)+"</code><br>链 "+job.chainId+"<br>函数 <code>"+esc(job.functionName)+"</code><table>"+args+"</table>";
}
$("connect").onclick=async()=>{
  if(busy) return; busy=true; $("who").className="muted"; $("who").textContent="正在连接 imKey…";
  try{
    const address=await ImKeyUsb.connectImKey();
    await post("/account",{address});
    $("who").className="ok"; $("who").textContent="imKey 地址 "+address+"，与 Owner 一致";
    $("sign").disabled=false;
  }catch(e){
    $("who").className="bad"; $("who").textContent=e.message||String(e);
    $("sign").disabled=true;
  }
  busy=false;
};
$("sign").onclick=async()=>{
  if(busy) return; busy=true; $("sign").disabled=true; $("result").className="muted"; $("result").textContent="请看 imKey 屏幕并确认。";
  try{
    const tx=await post("/prepare",{});
    const raw=await ImKeyUsb.signImKey(tx);
    const out=await post("/signed",{raw});
    $("result").className="ok";
    $("result").textContent="已上链 "+out.hash;
  }catch(e){
    $("result").className="bad"; $("result").textContent=e.message||String(e);
    $("sign").disabled=false;
  }
  busy=false;
};
fetch("/job").then(r=>r.json()).then(j=>{job=j; render();}).catch(e=>{$("job").textContent=e.message||e;});
</script></body></html>`;
}
