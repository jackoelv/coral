import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { parseWithdrawAmount } from "./treasury-withdraw.mjs";

const max = parseUnits("10", 18);

test("max 取当前可提取上限", () => {
  assert.equal(parseWithdrawAmount("max", max), max);
  assert.equal(parseWithdrawAmount("MAX", max), max);
});

test("按 USDT 个数换算成 18 位小数", () => {
  assert.equal(parseWithdrawAmount("1", max), parseUnits("1", 18));
  assert.equal(parseWithdrawAmount("1.5", max), parseUnits("1.5", 18));
});

test("拒绝 0、超额、过长小数和空金额", () => {
  assert.throws(() => parseWithdrawAmount("0", max), /大于 0/);
  assert.throws(() => parseWithdrawAmount("10.1", max), /超过可提取上限/);
  assert.throws(() => parseWithdrawAmount("1.0000000000000000001", max), /18 位小数/);
  assert.throws(() => parseWithdrawAmount("", max), /缺少 --amount/);
  assert.throws(() => parseWithdrawAmount("max", 0n), /是 0/);
});
