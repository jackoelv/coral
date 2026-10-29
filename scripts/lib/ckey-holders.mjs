import ExcelJS from "exceljs";
import { getAddress, zeroAddress } from "viem";

const UNIT = 10n ** 18n;

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Local time, `YYYY-MM-DD HH:mm:ss`. */
export function localTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `ckey-holders-YYYY-MM-DD-HHmmss.xlsx` in local time. */
export function snapshotFilename(date = new Date()) {
  const stamp = localTimestamp(date).replace(" ", "-").replaceAll(":", "");
  return `ckey-holders-${stamp}.xlsx`;
}

/** Exact decimal with 18 fractional digits. No rounding and no exponent. */
export function formatCkey(wei) {
  const value = BigInt(wei);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / UNIT;
  const fraction = (abs % UNIT).toString().padStart(18, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Applies one ERC-20 Transfer. Mint has a zero `from`, burn has a zero `to`.
 * Balances are keyed by checksum address. A negative balance throws.
 * Returns the checksum addresses whose balance changed, excluding the zero address.
 */
export function applyTransfer(balances, transfer) {
  const from = getAddress(transfer.from);
  const to = getAddress(transfer.to);
  const value = BigInt(transfer.value);
  if (value < 0n) throw new Error("Transfer 金额不能为负");
  const touched = [];
  if (from !== zeroAddress) {
    const next = (balances.get(from) ?? 0n) - value;
    if (next < 0n) throw new Error(`${from} 在区块记账后余额为负`);
    balances.set(from, next);
    touched.push(from);
  }
  if (to !== zeroAddress) {
    balances.set(to, (balances.get(to) ?? 0n) + value);
    touched.push(to);
  }
  return touched;
}

/** Applies transfers in order. Returns the addresses that changed. */
export function applyTransfers(balances, transfers) {
  const dirty = new Set();
  for (const transfer of transfers) {
    for (const address of applyTransfer(balances, transfer)) dirty.add(address);
  }
  return dirty;
}

export function sumBalances(balances) {
  let sum = 0n;
  for (const value of balances.values()) sum += value;
  return sum;
}

/** Holders with a positive balance, highest amount first, then address. */
export function holderRows(balances) {
  return [...balances.entries()]
    .filter(([, wei]) => wei > 0n)
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[1] > b[1] ? -1 : 1))
    .map(([address, wei]) => ({
      address,
      amount: formatCkey(wei),
      wei: wei.toString(),
    }));
}

/** Label/value rows for the summary sheet. Amounts stay decimal strings. */
export function captureRows(info) {
  return [
    ["代币合约", info.token],
    ["起始区块", info.startBlock],
    ["本次起始区块", info.fromBlock],
    ["本次结束区块", info.toBlock],
    ["链上头区块", info.headBlock],
    ["确认数", info.confirmations],
    ["Transfer条数", info.transferCount],
    ["持仓人数", info.holderCount],
    ["合计", info.total],
    ["totalSupply", info.totalSupply],
    ["抓取时间", info.capturedAt],
  ];
}

function writeTextRow(sheet, rowNumber, values) {
  const row = sheet.getRow(rowNumber);
  values.forEach((value, index) => {
    const cell = row.getCell(index + 1);
    cell.value = value == null ? "" : String(value);
    cell.numFmt = "@";
  });
  row.commit();
}

/** Writes the holder sheet and the capture sheet. Amounts are stored as text. */
export async function writeHolderWorkbook(file, holders, capture) {
  const book = new ExcelJS.Workbook();
  const positions = book.addWorksheet("持仓");
  writeTextRow(positions, 1, ["地址", "CKEY数量", "最小单位"]);
  holders.forEach((row, index) => writeTextRow(positions, index + 2, [row.address, row.amount, row.wei]));
  positions.getColumn(1).width = 46;
  positions.getColumn(2).width = 40;
  positions.getColumn(3).width = 40;

  const info = book.addWorksheet("本次抓取");
  capture.forEach((pair, index) => writeTextRow(info, index + 1, pair));
  info.getColumn(1).width = 18;
  info.getColumn(2).width = 66;
  await book.xlsx.writeFile(file);
}

/**
 * Next log range. `lastBlock` null means the ledger has never scanned.
 * When the finalized head is already included, `scan` is false and the range
 * stays on that block so the export still records a run.
 */
export function nextRange({ lastBlock, startBlock, finalized }) {
  if (finalized < startBlock) throw new Error(`确认高度 ${finalized} 还没到起始区块 ${startBlock}`);
  if (lastBlock !== null && lastBlock >= finalized) {
    return { fromBlock: lastBlock, toBlock: lastBlock, scan: false };
  }
  const fromBlock = lastBlock === null ? startBlock : lastBlock + 1n;
  return { fromBlock, toBlock: finalized, scan: true };
}
