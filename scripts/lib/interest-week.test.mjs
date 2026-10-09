import { test } from "node:test";
import assert from "node:assert/strict";
import { interestWeek, weekBoundary } from "./interest-week.mjs";

test("beijing sunday midnight is the only week step", () => {
  const boundary = weekBoundary(100n);
  assert.equal(interestWeek(boundary), 100n);
  assert.equal(interestWeek(boundary - 1n), 99n);
  assert.equal(interestWeek(boundary - 30n), 99n);
  assert.equal(interestWeek(boundary + WEEK_GAP()), 101n);
});

function WEEK_GAP() {
  return 7n * 24n * 60n * 60n;
}
