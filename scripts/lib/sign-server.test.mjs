import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSignPage, servePlan } from "./sign-server.mjs";
import { buildPlan, planTx, readPlan, writePlan } from "./sign-plan.mjs";

test("sign page offers imToken and still sends the extension transaction with gas", () => {
  const html = renderSignPage("abc");
  assert.match(html, /用手机 imToken 签名/);
  assert.match(html, /signImtoken/);
  assert.match(html, /用浏览器插件签/);
  assert.match(html, /eth_sendTransaction/);
  assert.match(html, /gas:pre\.gas/);
  assert.match(html, /accounts\[0\]/);
  assert.doesNotMatch(html, /writeContract/);
});

const SIGNER = "0x4A42DcC443b08902488d334423EFCB502F434A56";
const TARGET = "0xF4DfC2E4C156673761a3a1E2F4d855Ab3868f6B3";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

async function fakeChain(plan) {
  const state = { nonce: 3, broadcast: new Set() };
  const hex = (n) => `0x${n.toString(16)}`;
  const tx = (hash) => ({
    hash, from: SIGNER.toLowerCase(), to: TARGET.toLowerCase(), input: plan.txs[0].data, nonce: hex(state.nonce - 1),
    blockHash: `0x${"1".repeat(64)}`, blockNumber: "0x64", transactionIndex: "0x0", value: "0x0", gas: "0x5208", gasPrice: "0x1", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x38",
  });
  const receipt = (hash) => ({
    transactionHash: hash, from: SIGNER.toLowerCase(), to: TARGET.toLowerCase(), blockHash: `0x${"1".repeat(64)}`, blockNumber: "0x64", transactionIndex: "0x0",
    status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"0".repeat(512)}`, contractAddress: null, type: "0x0",
  });
  const answer = ({ method, params }) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_getTransactionCount") return hex(state.nonce);
    if (method === "eth_blockNumber") return "0x70";
    if (method === "eth_getTransactionByHash") return state.broadcast.has(params[0]) ? tx(params[0]) : null;
    if (method === "eth_getTransactionReceipt") return state.broadcast.has(params[0]) ? receipt(params[0]) : null;
    throw new Error(`fake rpc: ${method}`);
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const one = (call) => {
      try { return { jsonrpc: "2.0", id: call.id, result: answer(call) }; }
      catch (error) { return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: error.message } }; }
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(input) ? input.map(one) : one(input)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function fakePhone() {
  const calls = [];
  const session = {
    snapshot: () => ({ enabled: true, status: "connected", match: true, reconnect: true, account: SIGNER, message: "ok", qr: null }),
    send: (tx) => new Promise((resolve, reject) => calls.push({ tx, resolve, reject })),
    reconnect: async () => {},
    close: async () => {},
  };
  return { calls, open: async () => session };
}

async function setup(port) {
  const dir = mkdtempSync(join(tmpdir(), "sign-server-"));
  const planPath = join(dir, "plan.json");
  const plan = buildPlan({
    chainId: 56, signer: SIGNER, signerRole: "Publisher", purpose: "test",
    txs: [planTx({ label: "publishRoot", contract: "CoralRewards", to: TARGET, signature: "function publishRoot(bytes32 root, bytes32 contentHash, uint256 cumulative, string uri)", args: [`0x${"c".repeat(64)}`, `0x${"d".repeat(64)}`, 6n, ""] })],
  });
  writePlan(planPath, plan);
  const chain = await fakeChain(plan);
  const phone = fakePhone();
  const confirmed = [];
  const served = servePlan(planPath, {
    rpc: chain.url, allowed: [TARGET], port, walletConnectProjectId: "0".repeat(32),
    openSession: phone.open, openBrowser: false, onConfirmed: ({ tx }) => confirmed.push(tx.hash),
  });
  const base = `http://127.0.0.1:${port}`;
  let token = null;
  for (let i = 0; i < 50 && !token; i++) {
    token = await fetch(`${base}/`).then((r) => r.text()).then((html) => html.match(/const TOKEN="([0-9a-f]+)"/)?.[1]).catch(() => null);
    if (!token) await new Promise((r) => setTimeout(r, 50));
  }
  const post = (path, body = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-sign-token": token }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const plan_ = () => fetch(`${base}/plan`).then((r) => r.json());
  const waitFor = async (check) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timeout");
  };
  const cleanup = () => { chain.close(); rmSync(dir, { recursive: true, force: true }); };
  return { planPath, chain, phone, confirmed, served, post, plan: plan_, waitFor, cleanup };
}

test("a request the phone never received can be abandoned and signed again", { timeout: 30_000 }, async () => {
  const s = await setup(18761);
  try {
    const first = s.post("/wc/sign", { index: 0 });
    await s.waitFor(async () => (await s.plan()).waiting);
    const blocked = await s.post("/wc/sign", { index: 0 });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /放弃这次请求/);

    assert.equal((await s.post("/wc/abandon")).status, 200);
    assert.match((await first).body.error, /已放弃/);
    assert.equal((await s.plan()).waiting, null);

    const second = s.post("/wc/sign", { index: 0 });
    await s.waitFor(() => s.phone.calls.length === 2);
    s.chain.state.broadcast.add(HASH_B);
    s.chain.state.nonce += 1;
    s.phone.calls[1].resolve(HASH_B);
    assert.deepEqual((await second).body, { ok: true, hash: HASH_B });

    const result = await s.served;
    assert.equal(result.txs[0].status, "success");
    assert.equal(readPlan(s.planPath).txs[0].hash, HASH_B);
    assert.deepEqual(s.confirmed, [HASH_B]);
  } finally {
    s.cleanup();
  }
});

test("after abandoning, a moved nonce blocks re-signing and a late hash is still tracked", { timeout: 30_000 }, async () => {
  const s = await setup(18762);
  try {
    const first = s.post("/wc/sign", { index: 0 });
    await s.waitFor(async () => (await s.plan()).waiting);
    await s.post("/wc/abandon");
    await first;

    s.chain.state.nonce += 1;
    const refused = await s.post("/wc/sign", { index: 0 });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /nonce 从 3 变成了 4/);
    assert.equal(s.phone.calls.length, 1);

    s.chain.state.broadcast.add(HASH_A);
    s.phone.calls[0].resolve(HASH_A);
    const result = await s.served;
    assert.equal(result.txs[0].status, "success");
    assert.equal(result.txs[0].hash, HASH_A);
    assert.deepEqual(s.confirmed, [HASH_A]);
  } finally {
    s.cleanup();
  }
});

test("a confirmed tx stays success when the follow-up database step fails", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sign-server-"));
  const planPath = join(dir, "plan.json");
  const plan = buildPlan({
    chainId: 56, signer: SIGNER, signerRole: "Publisher", purpose: "test",
    txs: [planTx({ label: "publishRoot", contract: "CoralRewards", to: TARGET, signature: "function publishRoot(bytes32 root, bytes32 contentHash, uint256 cumulative, string uri)", args: [`0x${"c".repeat(64)}`, `0x${"d".repeat(64)}`, 6n, ""] })],
  });
  plan.txs[0].status = "submitted";
  plan.txs[0].hash = HASH_A;
  writePlan(planPath, plan);
  const chain = await fakeChain(plan);
  chain.state.nonce = 4;
  chain.state.broadcast.add(HASH_A);
  try {
    const result = await servePlan(planPath, {
      rpc: chain.url, allowed: [TARGET], port: 18763, openBrowser: false,
      onConfirmed: async () => { throw new Error("Connection terminated unexpectedly"); },
    });
    assert.equal(result.txs[0].status, "success");
    assert.equal(readPlan(planPath).txs[0].status, "success");
  } finally {
    chain.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
