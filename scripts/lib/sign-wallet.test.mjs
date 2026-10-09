import test from "node:test";
import assert from "node:assert/strict";
import { accountsOnChain, assertActiveSigner, buildSendParams, gasCeiling, walletConnectProjectId } from "./sign-wallet.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

test("gas ceiling stays at estimate times 1.5", () => {
  assert.equal(gasCeiling(1000n), "0x5dc");
  assert.equal(gasCeiling(2n), "0x3");
  assert.throws(() => gasCeiling(0n), /gas 估算无效/);
});

test("session accounts keep wallet order and ignore other chains", () => {
  const session = {
    namespaces: {
      eip155: {
        accounts: [
          `eip155:1:${A}`,
          `eip155:56:${B.toLowerCase()}`,
          `eip155:56:${C}`,
        ],
      },
    },
  };
  assert.deepEqual(accountsOnChain(session, 56), [B, C]);
  assert.deepEqual(accountsOnChain(null, 56), []);
});

test("the first imToken account must be the planned signer", () => {
  assert.equal(assertActiveSigner([A], A.toLowerCase(), 56), A);
  assert.throws(() => assertActiveSigner([B, A], A, 56), /当前账户是/);
  assert.throws(() => assertActiveSigner([], A, 56), /没有授权链 56/);
});

test("send params carry gas and a zero value", () => {
  assert.deepEqual(buildSendParams({ from: A, to: B, data: "0x1234", gas: "0x10" }), {
    from: A,
    to: B,
    data: "0x1234",
    value: "0x0",
    gas: "0x10",
  });
});

test("project id is a 32-hex Reown id or absent", () => {
  assert.equal(walletConnectProjectId(""), null);
  assert.equal(walletConnectProjectId(`  ${"ab".repeat(16)}  `), "ab".repeat(16));
  assert.throws(() => walletConnectProjectId("not-a-key"), /32 位十六进制/);
});
