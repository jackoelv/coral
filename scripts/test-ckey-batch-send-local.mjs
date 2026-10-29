/** Local only: 127.0.0.1:55438/ckey_test and 127.0.0.1:18548 chain id 56. Does not read .env. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createPublicClient, encodeDeployData, encodeFunctionData, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { activityCode, batchTransferPlan, parseBatchCsv } from './lib/ckey-batch.mjs';
import { asTerminalPlan, inspectAirdrop, sendPlannedTransfers } from './lib/ckey-batch-send.mjs';
import { writePlan } from './lib/sign-plan.mjs';

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const url = 'postgres://ckey_test@127.0.0.1:55438/ckey_test';
const db = new pg.Client({ connectionString: url });
const chain = createPublicClient({ transport: http('http://127.0.0.1:18548'), pollingInterval: 50 });
const account = privateKeyToAccount(ANVIL_KEY);
const dir = mkdtempSync(join(tmpdir(), 'ckey-send-'));
let mining = true;
const miner = setInterval(() => {
  if (mining) chain.request({ method: 'anvil_mine', params: ['0x1'] }).catch(() => {});
}, 150);

await db.connect();
try {
  assert.equal(await chain.getChainId(), 56, 'Anvil 必须是 chainId 56');
  const accounts = await chain.request({ method: 'eth_accounts' });
  assert.equal(getAddress(accounts[0]), account.address, 'Anvil 第一个账户必须是默认测试私钥');
  for (const table of ['activity_airdrop_intents', 'activity_airdrop_batches', 'activity_airdrop_transfers', 'activity_airdrop_campaigns']) {
    await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const file of ['002-ckey-airdrop.sql', '003-ckey-airdrop-recovery.sql']) {
    await db.query(readFileSync(new URL(`../mainnet/${file}`, import.meta.url), 'utf8'));
  }
  const artifact = JSON.parse(readFileSync(new URL('../out/CoralToken.sol/CoralToken.json', import.meta.url), 'utf8'));
  const send = async (data, to) => {
    const hash = await chain.request({ method: 'eth_sendTransaction', params: [{ from: account.address, ...(to ? { to } : {}), data, gas: '0x7a1200' }] });
    const receipt = await chain.waitForTransactionReceipt({ hash, confirmations: 1 });
    assert.equal(receipt.status, 'success');
    return receipt;
  };
  const token = getAddress((await send(encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [account.address] }))).contractAddress);
  await send(encodeFunctionData({ abi: artifact.abi, functionName: 'mint', args: [account.address, 10000n * 10n ** 18n] }), token);
  await send(encodeFunctionData({ abi: artifact.abi, functionName: 'setTransferAllowlist', args: [account.address, true] }), token);
  const recipients = [1, 2, 3].map((index) => getAddress(accounts[index]));
  const [paidA, paidB, retryTo] = recipients;

  const coded = getAddress('0x000000000000000000000000000000000000c0de');
  await chain.request({ method: 'anvil_setCode', params: [coded, '0xef'] });
  await assert.rejects(
    () => inspectAirdrop({ client: chain, token, from: coded, rows: [{ to: paidA, amount: 10n ** 18n }] }),
    /合约代码/,
  );

  const planPath = (name, rows, allowRepeat = false) => {
    const parsed = parseBatchCsv(['address,amount', ...rows.map((row) => `${row.to},${row.tokens}`)].join('\n'), account.address, `${name}.csv`);
    const plan = asTerminalPlan(batchTransferPlan({
      from: account.address, token, rows: parsed.rows, name: parsed.name, code: activityCode(parsed.name), allowRepeat, fingerprint: parsed.fingerprint,
    }));
    const path = join(dir, `${plan.meta.batchId}.json`);
    writePlan(path, plan);
    return path;
  };

  const happy = planPath('终端发放', [{ to: paidA, tokens: '100' }, { to: paidB, tokens: '100.000000000000000001' }]);
  await sendPlannedTransfers({ path: happy, client: chain, db, account, token });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM activity_airdrop_transfers')).rows[0].n, 2);
  assert.equal(await chain.readContract({ address: token, abi: artifact.abi, functionName: 'balanceOf', args: [paidA] }), 100n * 10n ** 18n);
  assert.equal(await chain.readContract({ address: token, abi: artifact.abi, functionName: 'balanceOf', args: [paidB] }), 100n * 10n ** 18n + 1n);
  const saved = readFileSync(happy, 'utf8');
  assert.equal(saved.includes(ANVIL_KEY), false);

  const beforeRepair = await chain.getTransactionCount({ address: account.address });
  const repair = planPath('补登记', [{ to: retryTo, tokens: '1' }]);
  let armed = true;
  const flaky = {
    on: db.on.bind(db),
    removeListener: db.removeListener.bind(db),
    query: async (sql, params) => {
      if (armed && String(sql).includes('INSERT INTO activity_airdrop_transfers')) {
        armed = false;
        throw new Error('database offline');
      }
      return db.query(sql, params);
    },
  };
  await assert.rejects(
    () => sendPlannedTransfers({ path: repair, client: chain, db: flaky, account, token }),
    /database offline/,
  );
  assert.equal((await db.query('SELECT count(*)::int AS n FROM activity_airdrop_transfers')).rows[0].n, 2);
  await sendPlannedTransfers({ path: repair, client: chain, db, account, token });
  assert.equal(await chain.getTransactionCount({ address: account.address }), beforeRepair + 1, '补登记不能再发一笔');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM activity_airdrop_transfers')).rows[0].n, 3);

  const before = [];
  for (let slot = 0; slot < 40; slot++) before.push(await chain.getStorageAt({ address: token, slot: `0x${slot.toString(16)}` }));
  await send(encodeFunctionData({ abi: artifact.abi, functionName: 'pause' }), token);
  let pausedSlot = -1;
  let pausedWord = '';
  for (let slot = 0; slot < 40; slot++) {
    const word = await chain.getStorageAt({ address: token, slot: `0x${slot.toString(16)}` });
    if (word !== before[slot]) { pausedSlot = slot; pausedWord = word; break; }
  }
  assert.notEqual(pausedSlot, -1, '找不到 paused 存储槽');
  await send(encodeFunctionData({ abi: artifact.abi, functionName: 'unpause' }), token);
  const unpausedWord = await chain.getStorageAt({ address: token, slot: `0x${pausedSlot.toString(16)}` });

  const revertTo = getAddress(accounts[4]);
  const reverting = planPath('回滚重发', [{ to: revertTo, tokens: '7' }]);
  mining = false;
  await chain.request({ method: 'anvil_setAutomine', params: [false] });
  await assert.rejects(() => sendPlannedTransfers({
    path: reverting, client: chain, db, account, token,
    afterBroadcast: async () => {
      await chain.request({ method: 'anvil_setStorageAt', params: [token, `0x${pausedSlot.toString(16)}`, pausedWord] });
      await chain.request({ method: 'anvil_mine', params: ['0x6'] });
    },
  }), /已回滚/);
  const intent = (await db.query('SELECT status, nonce FROM activity_airdrop_intents WHERE "recipientKey"=$1', [revertTo.toLowerCase()])).rows[0];
  assert.equal(intent.status, 'reserved');
  assert.equal(intent.nonce, null);
  await chain.request({ method: 'anvil_setStorageAt', params: [token, `0x${pausedSlot.toString(16)}`, unpausedWord] });
  await chain.request({ method: 'anvil_setAutomine', params: [true] });
  mining = true;
  await sendPlannedTransfers({ path: reverting, client: chain, db, account, token });
  assert.equal(await chain.readContract({ address: token, abi: artifact.abi, functionName: 'balanceOf', args: [revertTo] }), 7n * 10n ** 18n);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM activity_airdrop_transfers WHERE "verifiedAt" IS NOT NULL')).rows[0].n, 4);
  console.log(JSON.stringify({ ok: true, scope: 'local Anvil + isolated PostgreSQL only', checks: ['local key transfer', 'database record', 'repair without resend', 'reverted retry keeps calldata', 'contract account rejected'] }));
} finally {
  clearInterval(miner);
  await db.end();
}
