import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { allowlistCall, ckeySignPlan, mintCall, parseCkeyArgs, wholeTokens } from "./ckey-owner.mjs";
import { checkPlan } from "./sign-plan.mjs";

const TO = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

test("amount is a positive whole token count", () => {
  assert.equal(wholeTokens("1000"), 1000n * 10n ** 18n);
  assert.throws(() => wholeTokens("0"), /正整数/);
  assert.throws(() => wholeTokens("1.5"), /正整数/);
  assert.throws(() => wholeTokens(""), /正整数/);
});

test("mint and allowlist parse as separate commands", () => {
  const mint = parseCkeyArgs(["mint", "--to", TO.toLowerCase(), "--amount", "1000"]);
  assert.equal(mint.kind, "mint");
  assert.equal(mint.to, TO);
  assert.equal(mint.amount, 1000n * 10n ** 18n);
  assert.equal(mint.apply, false);
  assert.equal(mint.account, undefined);

  const listed = parseCkeyArgs(["allowlist", "--account", ACCOUNT, "--apply", "--port", "8758"]);
  assert.equal(listed.kind, "allowlist");
  assert.equal(listed.account, ACCOUNT);
  assert.equal(listed.apply, true);
  assert.equal(listed.port, 8758);
  assert.equal(listed.to, undefined);

  assert.throws(() => parseCkeyArgs(["mint", "--amount", "1"]), /--to/);
  assert.throws(() => parseCkeyArgs(["allowlist"]), /--account/);
  assert.throws(() => parseCkeyArgs(["allowlist", "--account", `0x${"0".repeat(40)}`]), /零地址/);
});

test("imToken plans are single owner calls", () => {
  const token = "0x3333333333333333333333333333333333333333";
  const owner = "0x4444444444444444444444444444444444444444";
  const mint = ckeySignPlan({ owner, token, kind: "mint", to: TO, amount: 5n * 10n ** 18n });
  const mintRow = checkPlan(mint, [token])[0];
  assert.equal(mint.signer, owner);
  assert.equal(mint.meta.kind, "ckeyMint");
  assert.equal(mintRow.functionName, "mint");
  assert.equal(mintRow.args[0].value, TO);
  assert.equal(mintRow.args[1].value, (5n * 10n ** 18n).toString());

  const allow = ckeySignPlan({ owner, token, kind: "allowlist", account: ACCOUNT });
  const allowRow = checkPlan(allow, [token])[0];
  assert.equal(allow.meta.kind, "ckeyAllowlist");
  assert.equal(allowRow.functionName, "setTransferAllowlist");
  assert.equal(allowRow.args[0].value, ACCOUNT);
  assert.equal(allowRow.args[1].value, true);
});

test("calls encode the owner functions and nothing else", () => {
  const mint = mintCall(TO, 5n * 10n ** 18n);
  assert.equal(mint.functionName, "mint");
  assert.equal(mint.data, encodeFunctionData({
    abi: parseAbi(["function mint(address to, uint256 amount)"]),
    functionName: "mint",
    args: [TO, 5n * 10n ** 18n],
  }));
  const allow = allowlistCall(ACCOUNT);
  assert.equal(allow.functionName, "setTransferAllowlist");
  assert.equal(allow.args[1].value, "true");
  assert.equal(allow.data, encodeFunctionData({
    abi: parseAbi(["function setTransferAllowlist(address account, bool allowed)"]),
    functionName: "setTransferAllowlist",
    args: [ACCOUNT, true],
  }));
});
