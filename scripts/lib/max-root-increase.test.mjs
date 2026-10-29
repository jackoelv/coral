import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { increasePlan, parseIncreaseArgs, parseIncreaseWei } from "./max-root-increase.mjs";
import { checkPlan } from "./sign-plan.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const REWARDS = "0x2222222222222222222222222222222222222222";
const AMOUNT = 318n * 10n ** 18n;

test("amount is a positive e18 integer", () => {
  assert.equal(parseIncreaseWei("318000000000000000000"), AMOUNT);
  assert.equal(parseIncreaseWei("318"), 318n);
  assert.equal(parseIncreaseWei(" 500000000000000000000 "), 500n * 10n ** 18n);
  for (const raw of ["", "0", "1.5", "318e18", "0x10", "+10"]) {
    assert.throws(() => parseIncreaseWei(raw), /e18/);
  }
});

test("args default to preview on port 8756", () => {
  const preview = parseIncreaseArgs(["--amount", AMOUNT.toString()]);
  assert.equal(preview.apply, false);
  assert.equal(preview.port, 8756);
  assert.equal(preview.amount, AMOUNT);
  const apply = parseIncreaseArgs(["--amount", AMOUNT.toString(), "--apply", "--port", "8761"]);
  assert.equal(apply.apply, true);
  assert.equal(apply.port, 8761);
  assert.throws(() => parseIncreaseArgs(["--amount", "318.0"]), /e18/);
  assert.throws(() => parseIncreaseArgs(["--amount", "1", "--port", "0"]), /port/);
});

test("plan is one owner call and the page shows the e18 integer", () => {
  const plan = increasePlan({ owner: OWNER, rewards: REWARDS, current: 100n * 10n ** 18n, amount: AMOUNT });
  const row = checkPlan(plan, [REWARDS])[0];
  assert.equal(plan.chainId, 56);
  assert.equal(plan.signer, OWNER);
  assert.equal(plan.signerRole, "Owner");
  assert.equal(plan.meta.kind, "setMaxRootIncrease");
  assert.equal(plan.meta.amount, AMOUNT.toString());
  assert.match(plan.purpose, /318 USDT/);
  assert.match(plan.purpose, new RegExp(AMOUNT.toString()));
  assert.equal(row.functionName, "setMaxRootIncrease");
  assert.equal(row.contract, "CoralRewards");
  assert.equal(row.to, REWARDS);
  assert.equal(row.args[0].name, "amount");
  assert.equal(row.args[0].type, "uint256");
  assert.equal(row.args[0].value, AMOUNT.toString());
  assert.equal(plan.txs[0].data, encodeFunctionData({
    abi: parseAbi(["function setMaxRootIncrease(uint256 amount)"]),
    functionName: "setMaxRootIncrease",
    args: [AMOUNT],
  }));
});
