import { test } from "node:test";
import assert from "node:assert/strict";
import { settleHistoricalTeam } from "./historical-team.mjs";

const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const UNIT = 10n ** 18n;

test("a later historical deposit uses the umbrella built by earlier imported orders", () => {
  const { rows, teamRewardWei, directExcluded } = settleHistoricalTeam([
    {
      wallet: A,
      referrer: null,
      selfWei: 10_000n * UNIT,
      orders: [{ usdt: 10_000, confirmedAt: 1_000 }],
    },
    {
      wallet: B,
      referrer: A,
      selfWei: 1_000n * UNIT,
      orders: [{ usdt: 1_000, confirmedAt: 2_000 }],
    },
  ]);
  const upline = rows.find((row) => row.wallet === A);
  assert.equal(upline.teamWei, 1_000n * UNIT);
  assert.equal(upline.teamRewardWei, 70n * UNIT);
  assert.equal(teamRewardWei, 70n * UNIT);
  assert.equal(directExcluded, 100n * UNIT);
});

test("imported volume that arrives before the upline reaches a tier pays no historical reward", () => {
  const { rows } = settleHistoricalTeam([
    {
      wallet: A,
      referrer: null,
      selfWei: 100n * UNIT,
      orders: [{ usdt: 100, confirmedAt: 1_000 }],
    },
    {
      wallet: B,
      referrer: A,
      selfWei: 10_000n * UNIT,
      orders: [{ usdt: 10_000, confirmedAt: 2_000 }],
    },
  ]);
  const upline = rows.find((row) => row.wallet === A);
  assert.equal(upline.teamWei, 10_000n * UNIT);
  assert.equal(upline.teamRewardWei, 0n);
});
