import pg from 'pg';
import { decodeFunctionData, decodeEventLog, getAddress, parseAbi } from 'viem';
import { contracts, need, productionDatabase, readMainnetEnv, mainnetClient } from './mainnet.mjs';
import { readPlan, writePlan } from './sign-plan.mjs';

const ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
export function planRows(plan, token) {
  if (plan?.meta?.kind !== 'ckeyBatchTransfer' || plan.chainId !== 56 || !plan.txs?.length) throw new Error('无效空投计划');
  const seen = new Set();
  return plan.txs.map(tx => {
    if (getAddress(tx.to) !== getAddress(token)) throw new Error('计划的代币不是当前 CKEY');
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: tx.data });
    if (functionName !== 'transfer' || args[1] <= 0n) throw new Error('无效 transfer');
    const recipient = getAddress(args[0]), key = recipient.toLowerCase();
    if (seen.has(key)) throw new Error('计划内重复地址'); seen.add(key);
    return { recipient, key, amountWei: String(args[1]) };
  });
}
export function immutableManifest(plan) {
  return { chainId: plan.chainId, signer: getAddress(plan.signer), meta: plan.meta,
    txs: plan.txs.map(tx => ({ to: getAddress(tx.to), data: tx.data.toLowerCase() })) };
}
export function verifyTransfer(plan, index, receipt, token) {
  const row = planRows(plan, token)[index];
  if (receipt.status !== 'success') throw new Error('链上交易未成功');
  const matches = receipt.logs.filter(log => {
    if (log.removed || log.address.toLowerCase() !== token.toLowerCase()) return false;
    try {
      const { eventName, args } = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      return eventName === 'Transfer' && getAddress(args.from) === getAddress(plan.signer)
        && getAddress(args.to) === row.recipient && String(args.value) === row.amountWei;
    } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('未找到唯一且金额、收款地址、发送者一致的 CKEY Transfer 事件');
  return { ...row, logIndex: matches[0].logIndex };
}
export async function openAirdropDb(env = readMainnetEnv()) {
  const url = env.DATABASE_URL_UNPOOLED?.trim() || need(env, 'DATABASE_URL');
  productionDatabase(url);
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await db.connect();
  try { await assertAirdropSchema(db); return db; } catch (e) { await db.end(); throw e; }
}
export async function assertAirdropSchema(db) {
  // Probe required columns before opening a wallet; this never creates tables.
  await db.query('SELECT id, manifest, fingerprint FROM activity_airdrop_batches LIMIT 0');
  await db.query('SELECT nonce, status, attempts, "batchId" FROM activity_airdrop_intents LIMIT 0');
  await db.query('SELECT "verifiedAt", "blockHash", "blockTimestamp" FROM activity_airdrop_transfers LIMIT 0');
}
export async function filterRecipients(db, { rows, code, allowRepeat, token, batchId = '' }) {
  const keys = rows.map(r => r.to.toLowerCase());
  const { rows: history } = await db.query(`
    SELECT lower(t.recipient) AS key, t."campaignCode" AS code, 'confirmed' AS status, '' AS batch
    FROM activity_airdrop_transfers t JOIN activity_airdrop_campaigns c ON c.code=t."campaignCode"
    WHERE lower(t.recipient)=ANY($1::text[]) AND c."chainId"=56 AND lower(c.token)=$2
    UNION ALL
    SELECT i."recipientKey", i."campaignCode", i.status, i."batchId"
    FROM activity_airdrop_intents i JOIN activity_airdrop_campaigns c ON c.code=i."campaignCode"
    WHERE i."recipientKey"=ANY($1::text[]) AND c."chainId"=56 AND lower(c.token)=$2`, [keys, token.toLowerCase()]);
  const skipped = [], eligible = [];
  for (const row of rows) {
    const entries = history.filter(h => h.key === row.to.toLowerCase() && !(batchId && h.batch === batchId));
    // An unresolved send must never be bypassed, even with --allow-repeat.
    const unresolved = entries.find(h => h.status !== 'confirmed');
    if (unresolved) throw new Error(`${row.to} 存在未完成计划 ${unresolved.batch}，先恢复原计划`);
    const previous = entries.find(h => h.code === code || !allowRepeat);
    if (previous) skipped.push({ to: row.to, reason: previous.code === code ? '本活动已发放' : '历史活动已发放' });
    else eligible.push(row);
  }
  return { rows: eligible, skipped };
}
export async function reserveBatch(db, plan, token) {
  if (plan.meta.airdropVersion !== 2 || !plan.meta.batchId) throw new Error('旧计划请先通过 --record-only 核实补登记，不能重新发放');
  const manifest = immutableManifest(plan), rows = planRows(plan, token);
  const { rows: existing } = await db.query('SELECT manifest=$2::jsonb AS matches FROM activity_airdrop_batches WHERE id=$1', [plan.meta.batchId, JSON.stringify(manifest)]);
  if (existing.length) { if (!existing[0].matches) throw new Error('计划内容已变动，拒绝执行'); return; }
  if (plan.txs.some(t => t.hash || t.status !== 'pending' || t.nonce != null)) throw new Error('未登记批次含有发送痕迹，须先核实历史交易');
  await db.query('BEGIN');
  try {
    const filtered = await filterRecipients(db, { rows: rows.map(r => ({ to: r.recipient, amount: BigInt(r.amountWei) })), code: plan.meta.code, allowRepeat: plan.meta.allowRepeat, token });
    if (filtered.skipped.length) throw new Error('预览后发放记录发生变化，请重新预览');
    if (!plan.meta.allowRepeat) {
      const match = await db.query('SELECT id FROM activity_airdrop_batches WHERE fingerprint=$1 LIMIT 1', [plan.meta.fingerprint]);
      if (match.rows.length) throw new Error('CSV 内容已登记，恢复原批次，不要改名重发');
    }
    await db.query('INSERT INTO activity_airdrop_campaigns (code,name,sender,token,"chainId") VALUES ($1,$2,$3,$4,56) ON CONFLICT (code) DO NOTHING', [plan.meta.code, plan.meta.name, getAddress(plan.signer), getAddress(token)]);
    const c = (await db.query('SELECT * FROM activity_airdrop_campaigns WHERE code=$1', [plan.meta.code])).rows[0];
    if (c.name !== plan.meta.name || c.sender.toLowerCase() !== plan.signer.toLowerCase() || c.token.toLowerCase() !== token.toLowerCase() || c.chainId !== 56) throw new Error('活动编码与已登记活动不一致');
    await db.query('INSERT INTO activity_airdrop_batches (id,"campaignCode",fingerprint,manifest) VALUES ($1,$2,$3,$4)', [plan.meta.batchId, plan.meta.code, plan.meta.fingerprint, JSON.stringify(manifest)]);
    for (const row of rows) await db.query('INSERT INTO activity_airdrop_intents ("campaignCode","recipientKey","batchId","amountWei") VALUES ($1,$2,$3,$4)', [plan.meta.code, row.key, plan.meta.batchId, row.amountWei]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
}
export async function lockAirdrop(db, token) {
  const { rows } = await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`ckey-airdrop:56:${token.toLowerCase()}`]);
  if (!rows[0].locked) throw new Error('另一个空投执行器正在运行');
}
export async function recordConfirmed(db, client, plan, index, token) {
  const tx = plan.txs[index];
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx.hash || '')) throw new Error('缺少有效交易哈希');
  const live = await client.getTransaction({ hash: tx.hash });
  if (getAddress(live.from) !== getAddress(plan.signer) || !live.to || getAddress(live.to) !== getAddress(token) || live.input.toLowerCase() !== tx.data.toLowerCase() || live.value !== 0n) throw new Error('实际交易与计划不一致');
  if (tx.nonce != null && live.nonce !== tx.nonce) throw new Error('交易 nonce 与计划不一致');
  if (plan.meta.airdropVersion === 2) {
    const expected = planRows(plan,token)[index];
    const intent = (await db.query('SELECT nonce, "amountWei" FROM activity_airdrop_intents WHERE "batchId"=$1 AND "recipientKey"=$2', [plan.meta.batchId,expected.key])).rows[0];
    if (!intent || intent.nonce === null || Number(intent.nonce) !== live.nonce || intent.amountWei !== expected.amountWei) throw new Error('链上交易与数据库保留的 nonce 或金额不一致');
  }
  const receipt = await client.waitForTransactionReceipt({ hash: tx.hash, confirmations: 3 });
  if (receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) throw new Error('交易被替换，先核实替换交易');
  const row = verifyTransfer(plan, index, receipt, token);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Error('区块重组，等待重新确认');
  await db.query('BEGIN');
  try {
    // Compare conflicts: silently ignoring a hash conflict could hide corrupt history.
    const old = (await db.query('SELECT * FROM activity_airdrop_transfers WHERE "txHash"=$1', [tx.hash.toLowerCase()])).rows[0];
    if (old && (old.campaignCode !== plan.meta.code || old.recipient.toLowerCase() !== row.key || old.amountWei !== row.amountWei)) throw new Error('交易哈希已有不一致登记');
    await db.query(`INSERT INTO activity_airdrop_transfers ("txHash","campaignCode",recipient,"amountWei","blockNumber","blockHash","logIndex","blockTimestamp","verifiedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT ("txHash") DO UPDATE SET "blockNumber"=EXCLUDED."blockNumber", "blockHash"=EXCLUDED."blockHash", "logIndex"=EXCLUDED."logIndex", "blockTimestamp"=EXCLUDED."blockTimestamp", "verifiedAt"=now()`,
    [tx.hash.toLowerCase(), plan.meta.code, row.recipient, row.amountWei, String(receipt.blockNumber), receipt.blockHash, row.logIndex, new Date(Number(block.timestamp) * 1000)]);
    if (plan.meta.airdropVersion === 2) {
      const updated = await db.query('UPDATE activity_airdrop_intents SET status=\'confirmed\', "txHash"=$1, "updatedAt"=now() WHERE "batchId"=$2 AND "recipientKey"=$3 AND "amountWei"=$4', [tx.hash.toLowerCase(), plan.meta.batchId, row.key, row.amountWei]);
      if (updated.rowCount !== 1) throw new Error('缺少对应发放占位');
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  tx.status = 'success'; tx.blockNumber = String(receipt.blockNumber); tx.recorded = true;
  return row;
}
/** Reconcile only. Never opens a wallet or sends a transaction. */
export async function recordCkeyAirdrop(path, env = readMainnetEnv()) {
  const plan = readPlan(path), token = contracts(env).CKEY;
  planRows(plan, token);
  if (!plan.txs.some(tx => tx.hash)) throw new Error('计划没有交易哈希，无需补登记');
  const client = await mainnetClient(env), db = await openAirdropDb(env);
  try {
    await lockAirdrop(db, token);
    if (plan.meta.airdropVersion === 2) await reserveBatch(db, plan, token);
    else {
      // Historical plans can only repair an existing campaign, not fabricate one from local JSON.
      const known = (await db.query('SELECT * FROM activity_airdrop_campaigns WHERE code=$1', [plan.meta.code])).rows[0];
      if (!known || known.sender.toLowerCase() !== plan.signer.toLowerCase() || known.token.toLowerCase() !== token.toLowerCase()) throw new Error('旧活动尚未登记，需先审查迁移，禁止自动创建');
    }
    for (let i=0; i<plan.txs.length; i++) if (plan.txs[i].hash) { await recordConfirmed(db, client, plan, i, token); writePlan(path, plan); }
    return plan;
  } finally { await db.end(); }
}

// Only a confirmed, matching reverted attempt may release its nonce for a retry.
export async function recoverReverted(db,client,plan,index,token,receipt) {
  if (receipt.status !== 'reverted') throw new Error('不是已回滚交易');
  const tx=plan.txs[index];
          const live = await client.getTransaction({ hash: tx.hash });
          if (getAddress(live.from) !== getAddress(plan.signer) || !live.to || getAddress(live.to) !== token || live.value !== 0n || live.input.toLowerCase() !== tx.data.toLowerCase() || receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) throw new Error('失败交易与计划不一致');
          const canonical = await client.getBlock({blockNumber:receipt.blockNumber});
          if (canonical.hash !== receipt.blockHash) throw new Error('失败交易区块发生重组，先等待确认');
          const row = planRows(plan,token)[index];
          const attempt = { hash: tx.hash, nonce: live.nonce, status: 'reverted', blockNumber: String(receipt.blockNumber) };
          const reset = await db.query(`UPDATE activity_airdrop_intents SET nonce=NULL,status='reserved', attempts=attempts || $1::jsonb WHERE "batchId"=$2 AND "recipientKey"=$3 AND status<>'confirmed' AND nonce=$4`, [JSON.stringify([attempt]),plan.meta.batchId,row.key,live.nonce]);
          if (reset.rowCount !== 1) {
            const prior=(await db.query('SELECT status,nonce,attempts FROM activity_airdrop_intents WHERE "batchId"=$1 AND "recipientKey"=$2',[plan.meta.batchId,row.key])).rows[0];
            if (!prior || prior.status !== 'reserved' || prior.nonce !== null || !prior.attempts.some(a=>a.hash===tx.hash)) throw new Error('失败交易 nonce 与发放占位不一致');
          }
          tx.attempts = [...(tx.attempts || []),attempt]; tx.hash=null; tx.nonce=null; tx.status='pending'; tx.recorded=false;
}
