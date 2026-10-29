import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { formatUnits, getAddress } from "viem";
import { parseBatchCsv, rowView } from "./ckey-batch.mjs";

/**
 * Local page for choosing the sender and uploading the CSV.
 * Amounts stay in wei. Signing happens afterwards on the existing imToken page.
 */
export async function serveBatchUpload({
  port = 8759,
  inspect,
  openBrowser = true,
  keepAlive = true,
  ready,
  preset = null,
  allowRepeat = false,
  expectedAmount = null,
}) {
  const token = randomBytes(24).toString("hex");
  let preview = null;
  let started = false;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: "只接受 127.0.0.1" });
    try {
      if (req.method === "GET" && req.url === "/") return send(200, page(token, preset, allowRepeat), "text/html; charset=utf-8");
      if (req.method !== "POST") return send(404, { error: "not found" });
      if (req.headers["x-sign-token"] !== token) return send(403, { error: "token 不对" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) throw new Error("上传超过 1MB");
      }
      const input = JSON.parse(body || "{}");
      if (req.url === "/preview") {
        const from = getAddress(input.from || "");
        const parsed = parseBatchCsv(input.csv || "", from, input.filename, { expectedAmount });
        const chain = await inspect({ from, ...parsed });
        const originalRows = parsed.rows;
        parsed.rows = chain.rows || parsed.rows;
        parsed.total = chain.total ?? parsed.total;
        const balanceWei = chain.balance.toString();
        const totalWei = parsed.total.toString();
        const remaining = chain.balance - parsed.total;
        preview = { id: randomBytes(16).toString("hex"), from, ...parsed, originalRows, chain, balanceWei };
        return send(200, {
          previewId: preview.id,
          name: parsed.name,
          duplicates: parsed.duplicates,
          skipped: chain.skipped || [],
          gasBudget: chain.gasBudget,
          code: chain.code,
          token: chain.token,
          allowRepeat,
          from,
          count: parsed.rows.length,
          totalWei,
          totalTokens: chain.totalTokens,
          balanceWei,
          balanceTokens: chain.balanceTokens,
          remainingWei: remaining.toString(),
          remainingTokens: formatUnits(remaining, 18),
          listed: chain.listed,
          enabled: chain.enabled,
          paused: chain.paused,
          rows: parsed.rows.map(rowView),
        });
      }
      if (req.url === "/start") {
        if (started) return send(409, { error: "已经开始签名" });
        if (!preview || input.previewId !== preview.id) return send(409, { error: "请先预览" });
        if (input.ack !== true) return send(409, { error: "请先预览并确认 CKEY 枚数与总额" });
        const chain = await inspect({ from: preview.from, name: preview.name, rows: preview.originalRows, total: preview.total });
        if (chain.rows && JSON.stringify(chain.rows.map(r=>r.to)) !== JSON.stringify(preview.rows.map(r=>r.to))) return send(409, { error: "发放记录已变化，请重新预览" });
        if (chain.balance.toString() !== preview.balanceWei) return send(409, { error: "链上余额已变化，请重新预览" });
        started = true;
        const job = {
          from: preview.from,
          name: preview.name,
          rows: preview.rows,
          total: preview.total,
          balance: chain.balance,
          code: chain.code,
          fingerprint: preview.fingerprint,
          duplicates: preview.duplicates,
          skipped: chain.skipped || [],
        };
        send(200, { ok: true, count: preview.rows.length });
        setTimeout(() => finish(job), 30);
        return;
      }
      return send(404, { error: "not found" });
    } catch (error) {
      return send(400, { error: error.shortMessage || error.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  if (!keepAlive) server.unref();
  ready?.();
  const pageUrl = `http://127.0.0.1:${port}/`;
  console.log(`批量转账页 ${pageUrl}`);
  if (openBrowser) openPage(pageUrl);
  try {
    return await done;
  } finally {
    server.close();
  }
}

export function renderBatchPage(token) {
  return page(token);
}

function openPage(url) {
  if (process.platform !== "darwin") return;
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function page(token, preset = null, allowRepeat = false) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CKEY 批量转账</title>
<style>
html{color-scheme:light}
body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:860px;margin:24px auto;padding:0 16px;background:#fff;color:#07363F}
.card{border:1px solid #cfe;border-radius:10px;padding:12px 16px;margin:12px 0}
.ok{color:#08804a}.bad{color:#b3261e}.muted{color:#678}
.wei{font:15px ui-monospace,monospace;word-break:break-all}
button{font-size:15px;padding:8px 16px;border-radius:8px;border:0;background:#00a8ab;color:#fff;cursor:pointer}
button:disabled{background:#9bb}
input[type=text]{width:100%;font:15px ui-monospace,monospace;padding:8px;border:1px solid #9cc;border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid #e5f4f2;padding:4px 6px;text-align:left}
code{word-break:break-all}
</style></head><body>
<h2>CKEY 批量转账</h2>
<div class="card">
<p>文件名就是活动名称。CSV 两列：<code>address,amount</code>。金额填 <code>100</code> 表示 100 枚 CKEY，支持最多 18 位小数，内部精确转换为 e18 最小单位。CSV 请放在仓库的 <code>activity/</code> 私有目录。</p><p class="bad">${allowRepeat ? "已启用 --allow-repeat：允许跨活动再次发放，同活动仍不可重复。" : "默认跳过历史已获得空投的地址；未完成计划必须先恢复。"}</p>
<label>转出地址<br><input id="from" type="text" placeholder="0x..." spellcheck="false"></label>
<p><input id="file" type="file" accept=".csv,text/csv"></p>
<p><button id="check">预览</button> <button id="go" disabled>确认</button></p>
<p id="msg" class="muted"></p>
</div>
<div id="result"></div>
<script>
const TOKEN=${JSON.stringify(token)};
const PRESET=${JSON.stringify(preset).replace(/</g, "\\u003c")};
const $=id=>document.getElementById(id);
let preview=null, csv=PRESET?PRESET.csv:"", filename=PRESET?PRESET.filename:"";
if(PRESET) $("msg").textContent="已读取 activity/"+filename;
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function clearPreview(){ preview=null; $("result").innerHTML=""; $("go").disabled=true; }
function pair(wei, tokens){ return '<div class="wei">'+esc(wei)+'</div><div class="muted">e18 · 折合 '+esc(tokens)+' 枚</div>'; }
async function post(path,body){
  const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-sign-token":TOKEN},body:JSON.stringify(body)});
  const j=await r.json(); if(!r.ok) throw new Error(j.error||r.status); return j;
}
$("from").oninput=clearPreview;
$("file").onchange=()=>{
  clearPreview();
  const file=$("file").files&&$("file").files[0];
  if(!file){ csv=""; filename=""; return; }
  filename=file.name;
  const reader=new FileReader();
  reader.onload=()=>{ csv=String(reader.result||""); };
  reader.readAsText(file);
};
$("check").onclick=async()=>{
  $("msg").className="muted"; $("msg").textContent="正在读取链上 e18 余额…";
  $("go").disabled=true;
  try{
    preview=await post("/preview",{from:$("from").value.trim(),csv,filename});
    const rows=preview.rows.map(r=>"<tr><td>"+r.line+"</td><td><code>"+esc(r.to)+"</code></td><td class=wei>"+esc(r.wei)+"</td><td class=muted>"+esc(r.tokens)+" 枚</td></tr>").join("");
    $("result").innerHTML='<div class="card"><b>'+esc(preview.name)+'</b><br>共 '+preview.count+' 笔<br>转出地址 <code>'+esc(preview.from)+'</code><br>白名单 '+(preview.listed?"在":"不在")+"，自由转账 "+(preview.enabled?"开":"关")+'<p>链：BSC 56 · CKEY <code>'+esc(preview.token)+'</code></p><p>合并重复行 '+preview.duplicates.length+'；跳过已发地址 '+preview.skipped.length+'</p><p>Gas 预算估算 '+esc(preview.gasBudget)+' BNB（随网络变化）</p><p>当前余额</p>'+pair(preview.balanceWei, preview.balanceTokens)+'<p>本场合计</p>'+pair(preview.totalWei, preview.totalTokens)+'<p>转出后剩余</p>'+pair(preview.remainingWei, preview.remainingTokens)+'<table><tr><th>行</th><th>地址</th><th>金额（e18）</th><th>折合</th></tr>'+rows+'</table><p class="muted">请核对上面的 CKEY 枚数及最小单位。确认后才打开签名页。用 imToken 扫码，或用 Chrome 里的钱包插件。每一行单独签一笔。</p></div>';
    $("go").disabled=false;
    $("msg").className="ok"; $("msg").textContent="预览完成。请核对 CKEY 枚数及最小单位，再点确认。";
  }catch(e){
    clearPreview();
    $("msg").className="bad"; $("msg").textContent=e.message||String(e);
  }
};
$("go").onclick=start;
async function start(){
  if(!preview) return;
  $("go").disabled=true;
  try{
    await post("/start",{previewId:preview.previewId,ack:true});
    $("msg").className="ok"; $("msg").textContent="签名页即将打开。请在那个页面用 imToken 或浏览器插件按顺序确认。";
  }catch(e){
    $("msg").className="bad"; $("msg").textContent=e.message||String(e);
    if (/重新预览/.test(e.message||"")) clearPreview();
    else $("go").disabled=!preview;
  }
}
</script></body></html>`;
}
