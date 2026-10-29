import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { allowlistCall } from "./ckey-owner.mjs";
import { imkeyBrowserBundle } from "./imkey-bundle.mjs";
import { assertSignedCall, renderImkeyPage, serveImkey } from "./imkey-page.mjs";
import { ecdsaRecover, signatureNormalize } from "./secp256k1-browser.mjs";
import { ethers } from "ethers";

const OWNER_KEY = `0x${"11".repeat(32)}`;
const OWNER = privateKeyToAccount(OWNER_KEY);
const TOKEN = "0x3333333333333333333333333333333333333333";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const CALL = allowlistCall(ACCOUNT);

test("imKey browser bundle exposes the USB signer", async () => {
  const js = await imkeyBrowserBundle();
  assert.match(js, /connectImKey/);
  assert.match(js, /signImKey/);
  assert.match(js, /navigator\.usb/);
  assert.doesNotMatch(js, /writeContract/);
});

test("imKey page sends the device signature and does not use writeContract", () => {
  const html = renderImkeyPage("abc");
  assert.match(html, /连接 imKey/);
  assert.match(html, /ImKeyUsb\.connectImKey/);
  assert.match(html, /ImKeyUsb\.signImKey/);
  assert.match(html, /src="\/imkey.js"/);
  assert.doesNotMatch(html, /writeContract/);
  assert.doesNotMatch(html, /eth_sendTransaction/);
});

test("signature helper recovers the signer public key", () => {
  const wallet = ethers.Wallet.createRandom();
  const digest = ethers.utils.keccak256("0x1234");
  const sig = wallet._signingKey().signDigest(digest);
  const compact = Buffer.concat([
    Buffer.from(sig.r.slice(2), "hex"),
    Buffer.from(sig.s.slice(2), "hex"),
  ]);
  signatureNormalize(compact);
  const pub = ecdsaRecover(compact, sig.recoveryParam, Buffer.from(digest.slice(2), "hex"), false);
  assert.equal(`0x${Buffer.from(pub).toString("hex")}`, wallet.publicKey.toLowerCase());
});

test("a signed call is accepted only when every field matches", async () => {
  const expected = {
    chainId: 56,
    from: OWNER.address,
    to: TOKEN,
    data: CALL.data,
    nonce: 3n,
    gas: 21000n,
    gasPrice: 1_000_000_000n,
  };
  const raw = await OWNER.signTransaction({
    type: "legacy",
    chainId: expected.chainId,
    nonce: expected.nonce,
    gas: expected.gas,
    gasPrice: expected.gasPrice,
    to: expected.to,
    value: 0n,
    data: expected.data,
  });
  assert.equal((await assertSignedCall(raw, expected)).nonce, 3);
  await assert.rejects(() => assertSignedCall(raw, { ...expected, nonce: 4n }), /nonce/);
  await assert.rejects(() => assertSignedCall(raw, { ...expected, data: `${CALL.data}00` }), /calldata/);
  await assert.rejects(() => assertSignedCall("0x1234", expected), /可解析/);
});

function fakeChain() {
  const state = { raw: null };
  const hash = `0x${"ab".repeat(32)}`;
  const answer = ({ method, params }) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_getTransactionCount") return "0x3";
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_sendRawTransaction") {
      state.raw = params[0];
      return hash;
    }
    if (method === "eth_getTransactionByHash") {
      if (!state.raw) return null;
      return {
        hash, from: OWNER.address, to: TOKEN, input: CALL.data, nonce: "0x3", value: "0x0",
        gas: "0x7b0", gasPrice: "0x3b9aca00", blockNumber: "0x64", blockHash: `0x${"1".repeat(64)}`,
        transactionIndex: "0x0", type: "0x0",
      };
    }
    if (method === "eth_getTransactionReceipt") {
      if (!state.raw) return null;
      return {
        transactionHash: hash, from: OWNER.address, to: TOKEN, blockNumber: "0x64",
        blockHash: `0x${"1".repeat(64)}`, transactionIndex: "0x0", status: "0x1",
        gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
        logs: [], logsBloom: `0x${"0".repeat(512)}`, contractAddress: null, type: "0x0",
      };
    }
    if (method === "eth_blockNumber") return "0x70";
    if (method === "eth_getBlockByNumber") {
      return { number: params[0], hash: `0x${"1".repeat(64)}`, timestamp: "0x1", parentHash: `0x${"2".repeat(64)}`, transactions: [] };
    }
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        hash,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
      });
    });
  });
}

test("the page broadcasts only after the imKey signature matches the prepared call", { timeout: 20_000 }, async () => {
  const chain = await fakeChain();
  const port = 18771;
  const served = serveImkey({
    rpc: chain.url,
    chainId: 56,
    owner: OWNER.address,
    token: TOKEN,
    purpose: "把地址加入白名单",
    call: CALL,
    port,
    openBrowser: false,
    confirmations: 1,
    keepAlive: false,
    bundle: async () => "window.ImKeyUsb={connectImKey(){},signImKey(){}}",
  });
  const base = `http://127.0.0.1:${port}`;
  let session = null;
  for (let i = 0; i < 50 && !session; i++) {
    session = await fetch(`${base}/`).then((r) => r.text()).then((html) => html.match(/const TOKEN="([0-9a-f]+)"/)?.[1]).catch(() => null);
    if (!session) await new Promise((r) => setTimeout(r, 20));
  }
  const post = (path, body) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sign-token": session },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const html = await fetch(`${base}/`).then((r) => r.text());
    assert.match(html, /连接 imKey/);
    const wrong = await post("/account", { address: ACCOUNT });
    assert.equal(wrong.status, 409);
    assert.equal((await post("/prepare", {})).status, 409);
    assert.equal((await post("/account", { address: OWNER.address })).status, 200);
    const prepared = await post("/prepare", {});
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.value, "0x0");
    assert.equal(prepared.body.gasLimit, "31500");
    const raw = await OWNER.signTransaction({
      type: "legacy",
      chainId: 56,
      nonce: BigInt(prepared.body.nonce),
      gas: BigInt(prepared.body.gasLimit),
      gasPrice: BigInt(prepared.body.gasPrice),
      to: prepared.body.to,
      value: 0n,
      data: prepared.body.data,
    });
    const sent = await post("/signed", { raw });
    assert.equal(sent.status, 200, sent.body.error);
    assert.equal(sent.body.hash, chain.hash);
    assert.equal(chain.state.raw.toLowerCase(), raw.toLowerCase());
    assert.equal((await served).hash, chain.hash);
  } finally {
    chain.close();
  }
});
