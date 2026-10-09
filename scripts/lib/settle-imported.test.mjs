import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillInterest, calendarWeek, FIRST_SUNDAY_BEIJING, CALENDAR_WEEK, nftsOwed, settlePlan, tokensFor, UNIT } from "./settle-imported.mjs";

const wallet = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const rate = 100n * UNIT;

test("1000 USDT owes 2 NFTs and 100000 CKEY", () => {
  assert.equal(nftsOwed(1000n * UNIT), 2n);
  assert.equal(tokensFor(1000n * UNIT, rate), 100_000n * UNIT);
  const plan = settlePlan({
    wallet,
    volume: 1000n * UNIT,
    nemoBalance: 0n,
    importedNfts: 2n,
    grantedNfts: 0n,
    tokensPerUsdt: rate,
  });
  assert.equal(plan.nemoMint, 100_000n * UNIT);
  assert.equal(plan.nftGrant, 2n);
});

test("500 USDT has CKEY but no NFT", () => {
  const plan = settlePlan({
    wallet,
    volume: 500n * UNIT,
    nemoBalance: 0n,
    importedNfts: 0n,
    grantedNfts: 0n,
    tokensPerUsdt: rate,
  });
  assert.equal(plan.nemoMint, 50_000n * UNIT);
  assert.equal(plan.nftGrant, 0n);
});

test("a second run mints nothing when the wallet already holds the expected CKEY", () => {
  const plan = settlePlan({
    wallet,
    volume: 1500n * UNIT,
    nemoBalance: 150_000n * UNIT,
    importedNfts: 3n,
    grantedNfts: 3n,
    tokensPerUsdt: rate,
  });
  assert.equal(plan.nemoMint, 0n);
  assert.equal(plan.nftGrant, 0n);
});

test("later deposit volume stays covered when the vault already minted that part", () => {
  const plan = settlePlan({
    wallet,
    volume: 1600n * UNIT,
    nemoBalance: 160_000n * UNIT,
    importedNfts: 3n,
    grantedNfts: 3n,
    tokensPerUsdt: rate,
  });
  assert.equal(plan.nemoMint, 0n);
});

test("imported NFT count cannot exceed the volume rule", () => {
  assert.throws(
    () => settlePlan({
      wallet,
      volume: 1000n * UNIT,
      nemoBalance: 0n,
      importedNfts: 3n,
      grantedNfts: 0n,
      tokensPerUsdt: rate,
    }),
    /超过业绩应发/,
  );
});

function atWeek(week) {
  return FIRST_SUNDAY_BEIJING + week * CALENDAR_WEEK + 3600n;
}

test("two NFTs earn 1 percent for each finished week before the sale week", () => {
  const saleWeek = 120n;
  const interest = backfillInterest({
    orders: [{ usdt: 1000, confirmedAt: atWeek(100n) }],
    tokensPerUsdt: rate,
    saleOpenedAt: atWeek(saleWeek),
    now: atWeek(saleWeek),
  });
  assert.equal(calendarWeek(atWeek(100n)), 100n);
  assert.equal(interest.weeks, 20n);
  assert.equal(interest.gross, 20n * 1000n * UNIT);
  assert.equal(interest.actual, interest.gross);
  assert.equal(interest.since, atWeek(100n));
});

test("later NFTs do not reprice the weeks before they existed", () => {
  const interest = backfillInterest({
    orders: [
      { usdt: 1000, confirmedAt: atWeek(100n) },
      { usdt: 500, confirmedAt: atWeek(110n) },
    ],
    tokensPerUsdt: rate,
    saleOpenedAt: atWeek(120n),
    now: atWeek(120n),
  });
  assert.equal(interest.weeks, 20n);
  assert.equal(interest.gross, 10n * 1000n * UNIT + 10n * 1500n * UNIT);
  assert.equal(interest.finalNfts, 3n);
});

test("the sale week itself is left to the interest contract", () => {
  const interest = backfillInterest({
    orders: [{ usdt: 1000, confirmedAt: atWeek(120n) }],
    tokensPerUsdt: rate,
    saleOpenedAt: atWeek(120n) + 10n,
    now: atWeek(121n),
  });
  assert.equal(interest.weeks, 0n);
  assert.equal(interest.gross, 0n);
  assert.equal(interest.actual, 0n);
});

test("a wallet cannot be backfilled above 100 percent of NFT principal", () => {
  const interest = backfillInterest({
    orders: [{ usdt: 1000, confirmedAt: atWeek(1n) }],
    tokensPerUsdt: rate,
    saleOpenedAt: atWeek(201n),
    now: atWeek(201n),
  });
  assert.equal(interest.weeks, 200n);
  assert.equal(interest.gross, 200n * 1000n * UNIT);
  assert.equal(interest.actual, 100_000n * UNIT);
});

test("a second run mints only the interest that was not paid yet", () => {
  const again = backfillInterest({
    orders: [{ usdt: 1000, confirmedAt: atWeek(100n) }],
    tokensPerUsdt: rate,
    saleOpenedAt: atWeek(120n),
    now: atWeek(120n),
    alreadyPaid: 20n * 1000n * UNIT,
  });
  assert.equal(again.gross, 20n * 1000n * UNIT);
  assert.equal(again.actual, 0n);
});
