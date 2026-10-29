import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { formatUnits, getAddress, parseUnits, maxUint256, zeroAddress } from 'viem';
import { buildPlan, planTx } from './sign-plan.mjs';

export const MAX_BATCH_ROWS = 300;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function tokenAmount(raw) {
  const text = String(raw ?? '').trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(text)) throw new Error('金额须为 CKEY 枚数（如 100 或 100.5），最多 18 位小数；不接受科学计数法或千分位');
  const value = parseUnits(text, 18);
  if (value <= 0n || value > maxUint256) throw new Error('金额须大于 0 且不超过 uint256');
  return value;
}
export function activityName(filename) {
  if (typeof filename !== 'string' || !/\.csv$/i.test(filename)) throw new Error('请选择 activity/ 下的 CSV 文件');
  const name = basename(filename).replace(/\.csv$/i, '').normalize('NFC').trim();
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error('活动文件名须为 1–80 个字');
  return name;
}
export function activityCode(name) { return `AD-${digest(name.normalize('NFC').trim()).slice(0, 24).toUpperCase()}`; }
export function contentFingerprint(rows) {
  return digest(rows.map(r => `${r.to.toLowerCase()}:${r.amount}`).sort().join('\n'));
}
function cells(line) {
  const out = []; let current = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; } else quoted = !quoted;
    } else if (line[i] === ',' && !quoted) { out.push(current.trim()); current = ''; }
    else current += line[i];
  }
  if (quoted) throw new Error('引号没有闭合');
  out.push(current.trim()); return out;
}
export function parseBatchCsv(text, from, filename, { expectedAmount = null } = {}) {
  const name = activityName(filename), body = String(text ?? '').replace(/^\uFEFF/, '');
  if (Buffer.byteLength(body) > 1_000_000) throw new Error('CSV 超过 1MB');
  const sender = from ? getAddress(from.toLowerCase()) : null;
  if (sender === zeroAddress) throw new Error('转出地址不能是零地址');
  const rows = [], duplicates = [], seen = new Map(); let skippedHeader = false;
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parts = cells(line.trim()), lineNo = index + 1;
    if (parts.length !== 2) throw new Error(`第 ${lineNo} 行必须恰好两列：地址、CKEY 枚数`);
    if (rows.length === 0 && !skippedHeader && /^(address|地址|wallet|to)$/i.test(parts[0])) { skippedHeader = true; continue; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(parts[0])) throw new Error(`第 ${lineNo} 行地址无效`);
    const to = getAddress(parts[0].toLowerCase());
    if (to === zeroAddress || to === sender) throw new Error(`第 ${lineNo} 行是零地址或转出地址`);
    let amount; try { amount = tokenAmount(parts[1]); } catch (e) { throw new Error(`第 ${lineNo} 行：${e.message}`); }
    if (expectedAmount !== null && amount !== expectedAmount) throw new Error(`第 ${lineNo} 行不是本批要求的 ${formatUnits(expectedAmount, 18)} CKEY`);
    if (seen.has(to)) {
      const first = seen.get(to);
      if (first.amount !== amount) throw new Error(`第 ${first.line} / ${lineNo} 行同一地址金额冲突`);
      duplicates.push({ line: lineNo, firstLine: first.line, to }); continue;
    }
    const row = { line: lineNo, to, amount }; seen.set(to, row); rows.push(row);
  }
  if (!rows.length || rows.length > MAX_BATCH_ROWS) throw new Error(`有效地址数量必须为 1–${MAX_BATCH_ROWS}`);
  const total = rows.reduce((sum, row) => sum + row.amount, 0n);
  if (total > maxUint256) throw new Error('总额超过 uint256');
  return { rows, total, name, skippedHeader, duplicates, fingerprint: contentFingerprint(rows) };
}
export function assertCanSend({ code, paused, enabled, listed, balance, total }) {
  if (code && code !== '0x') throw new Error('转出账户有合约代码（包括智能账户），当前批量工具仅支持普通 EOA');
  if (paused) throw new Error('CKEY 已暂停');
  if (!enabled && !listed) throw new Error('转出地址不在白名单且自由转账未开启');
  if (balance < total) throw new Error(`余额 ${formatUnits(balance, 18)} CKEY 不够转出 ${formatUnits(total, 18)} CKEY`);
}
export function batchTransferPlan({ from, token, rows, code, name, allowRepeat = false, fingerprint, duplicates = [], skipped = [] }) {
  if (!/^AD-[A-Z0-9-]{8,64}$/.test(code) || !name || name.length > 80) throw new Error('活动名称或编码无效');
  const total = rows.reduce((sum, row) => sum + row.amount, 0n);
  return buildPlan({ chainId: 56, signer: getAddress(from), signerRole: '空投转出账户',
    purpose: `${name}：${rows.length} 笔，合计 ${formatUnits(total, 18)} CKEY${allowRepeat ? '（允许跨活动再次发放）' : ''}`,
    meta: { kind: 'ckeyBatchTransfer', airdropVersion: 2, batchId: randomUUID(), code, name, count: rows.length, total: String(total), allowRepeat, fingerprint: fingerprint || contentFingerprint(rows), duplicates, skipped },
    txs: rows.map(row => planTx({ label: `第 ${row.line} 行 ${formatUnits(row.amount, 18)} CKEY`, contract: 'CoralToken', to: token,
      signature: 'function transfer(address to, uint256 amount) returns (bool)', args: [row.to, row.amount] })),
  });
}
export function rowView(row) { return { line: row.line, to: row.to, wei: String(row.amount), tokens: formatUnits(row.amount, 18) }; }
