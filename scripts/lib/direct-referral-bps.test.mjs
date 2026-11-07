import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { checkPlan } from "./sign-plan.mjs";
import { chooseSwitchBlock, parseBlock, parseTierArgs } from "./tier-v3-block.mjs";
import { directPlan, parseDirectArgs } from "./direct-referral-bps.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const IDO = "0x2222222222222222222222222222222222222222";

test("direct plan is one owner call that sets 500", () => {
  const preview = parseDirectArgs([]);
  assert.equal(preview.apply, false);
  assert.equal(preview.port, 8757);
  const plan = directPlan({ owner: OWNER, ido: IDO, current: 1000n });
  const row = checkPlan(plan, [IDO])[0];
  assert.equal(plan.chainId, 56);
  assert.equal(plan.signer, OWNER);
  assert.equal(plan.meta.kind, "setDirectReferralBps");
  assert.equal(plan.meta.bps, "500");
  assert.equal(row.functionName, "setDirectReferralBps");
  assert.equal(row.contract, "CoralIdo");
  assert.equal(row.to, IDO);
  assert.equal(row.args[0].value, "500");
  assert.equal(plan.txs[0].data, encodeFunctionData({
    abi: parseAbi(["function setDirectReferralBps(uint256 bps)"]),
    functionName: "setDirectReferralBps",
    args: [500n],
  }));
});

test("switch block stays ahead of the head and the indexer", () => {
  assert.equal(chooseSwitchBlock({ head: 1000n, indexed: 980n }), 7000n);
  assert.equal(parseTierArgs(["--block", "8000", "--apply"]).block, 8000n);
  assert.equal(chooseSwitchBlock({ head: 1000n, indexed: 980n, requested: 8000n }), 8000n);
  assert.throws(() => chooseSwitchBlock({ head: 1000n, requested: 1000n }), /链头/);
  assert.throws(() => chooseSwitchBlock({ head: 6000n, indexed: 8000n, requested: 7000n }), /检查点/);
  assert.throws(() => parseBlock("0", "--block"), /区块号/);
});
