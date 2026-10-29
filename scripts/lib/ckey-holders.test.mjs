import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { getAddress, zeroAddress } from "viem";
import { applyTransfer, applyTransfers, captureRows, formatCkey, holderRows, localTimestamp, nextRange, snapshotFilename, sumBalances, writeHolderWorkbook } from "./ckey-holders.mjs";

const UNIT = 10n ** 18n;
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("mint, transfer, and burn update balances", () => {
  const balances = new Map();
  const dirty = applyTransfers(balances, [
    { from: zeroAddress, to: A.toLowerCase(), value: 100n * UNIT },
    { from: A, to: B, value: 40n * UNIT },
    { from: B, to: zeroAddress, value: 10n * UNIT },
  ]);
  assert.equal(balances.get(getAddress(A)), 60n * UNIT);
  assert.equal(balances.get(B), 30n * UNIT);
  assert.equal(sumBalances(balances), 90n * UNIT);
  assert.equal(dirty.has(getAddress(A)), true);
  assert.equal(dirty.has(zeroAddress), false);

  const rows = holderRows(balances);
  assert.deepEqual(rows.map((row) => row.address), [getAddress(A), B]);
  assert.equal(rows[0].amount, "60.000000000000000000");
  assert.equal(rows[0].wei, (60n * UNIT).toString());
  assert.equal(rows[1].amount, "30.000000000000000000");
});

test("a full burn stays in the map at zero and leaves the holder list", () => {
  const balances = new Map();
  applyTransfers(balances, [
    { from: zeroAddress, to: A, value: 5n },
    { from: A, to: zeroAddress, value: 5n },
  ]);
  assert.equal(balances.get(A), 0n);
  assert.equal(holderRows(balances).length, 0);
  assert.equal(sumBalances(balances), 0n);
});

test("equal balances sort by address", () => {
  const balances = new Map();
  applyTransfers(balances, [
    { from: zeroAddress, to: B, value: UNIT },
    { from: zeroAddress, to: A, value: UNIT },
  ]);
  assert.deepEqual(holderRows(balances).map((row) => row.address), [A, B]);
});

test("a transfer that would go negative is rejected", () => {
  assert.throws(() => applyTransfer(new Map(), { from: A, to: B, value: 1n }), /余额为负/);
  assert.throws(() => applyTransfer(new Map(), { from: zeroAddress, to: A, value: -1n }), /不能为负/);
});

test("format keeps amounts above 2^63 as exact decimals", () => {
  assert.equal(formatCkey(1n), "0.000000000000000001");
  assert.equal(formatCkey(10n ** 27n + 1n), "1000000000.000000000000000001");
});

test("filename uses local time down to the second", () => {
  const date = new Date(2026, 9, 23, 12, 24, 30);
  assert.equal(localTimestamp(date), "2026-10-23 12:24:30");
  assert.equal(snapshotFilename(date), "ckey-holders-2026-10-23-122430.xlsx");
});

test("scan range is incremental and a caught-up head does not rescan", () => {
  assert.deepEqual(nextRange({ lastBlock: null, startBlock: 10n, finalized: 20n }), { fromBlock: 10n, toBlock: 20n, scan: true });
  assert.deepEqual(nextRange({ lastBlock: 15n, startBlock: 10n, finalized: 20n }), { fromBlock: 16n, toBlock: 20n, scan: true });
  assert.deepEqual(nextRange({ lastBlock: 20n, startBlock: 10n, finalized: 20n }), { fromBlock: 20n, toBlock: 20n, scan: false });
  assert.deepEqual(nextRange({ lastBlock: 21n, startBlock: 10n, finalized: 20n }), { fromBlock: 21n, toBlock: 21n, scan: false });
  assert.throws(() => nextRange({ lastBlock: null, startBlock: 30n, finalized: 20n }), /起始区块/);
});

test("workbook keeps the full wei string as text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ckey-holders-"));
  const file = join(dir, "holders.xlsx");
  const wei = (10n ** 27n + 1n).toString();
  try {
    await writeHolderWorkbook(file, [{ address: A, amount: formatCkey(wei), wei }], [["totalSupply", wei]]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(file);
    const positions = book.getWorksheet("持仓");
    const info = book.getWorksheet("本次抓取");
    assert.equal(positions.getCell("A1").value, "地址");
    assert.equal(positions.getCell("B2").value, "1000000000.000000000000000001");
    assert.equal(positions.getCell("C2").value, wei);
    assert.equal(info.getCell("A1").value, "totalSupply");
    assert.equal(info.getCell("B1").value, wei);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summary rows keep the capture fields", () => {
  const rows = captureRows({
    token: A,
    startBlock: "10",
    fromBlock: "16",
    toBlock: "20",
    headBlock: "35",
    confirmations: "15",
    transferCount: "2",
    holderCount: "1",
    total: "60.000000000000000000",
    totalSupply: (60n * UNIT).toString(),
    capturedAt: "2026-10-23 12:24:30",
  });
  assert.equal(rows[0][1], A);
  assert.equal(rows.find(([label]) => label === "本次结束区块")[1], "20");
  assert.equal(rows.find(([label]) => label === "totalSupply")[1], (60n * UNIT).toString());
});
