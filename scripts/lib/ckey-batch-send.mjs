import { formatUnits, getAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertCanSend } from './ckey-batch.mjs';
import { lockAirdrop, planRows, reserveBatch, recordConfirmed, recoverReverted } from './ckey-airdrop-record.mjs';
import { need } from './mainnet.mjs';
import { readPlan, writePlan } from './sign-plan.mjs';

/** Plans written by this terminal signer. Browser plans do not carry it. */
export const TERMINAL_CHANNEL = 'terminal-key';
const TOKEN_ABI = parseAbi([
  'function paused() view returns (bool)',
  'function transfersEnabled() view returns (bool)',
  'function transferAllowlist(address) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** Dedicated airdrop key from an env object. Never the deployer key. */
export function airdropAccount(env) {
  const raw = need(env, 'CKEY_AIRDROP_PRIVATE_KEY').trim();
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('CKEY_AIRDROP_PRIVATE_KEY 必须是 32 字节私钥');
  const deployerRaw = (env.MAINNET_PRIVATE_KEY || '').trim();
  const deployerKey = deployerRaw ? (deployerRaw.startsWith('0x') ? deployerRaw : `0x${deployerRaw}`) : '';
  if (deployerKey && deployerKey.toLowerCase() === key.toLowerCase()) throw new Error('CKEY_AIRDROP_PRIVATE_KEY 不能复用 MAINNET_PRIVATE_KEY');
  const account = privateKeyToAccount(key);
  if (env.MAINNET_DEPLOYER && getAddress(env.MAINNET_DEPLOYER) === account.address) throw new Error('空投地址不能是部署账户');
  return account;
}

export function asTerminalPlan(plan) {
  plan.meta = { ...plan.meta, channel: TERMINAL_CHANNEL };
  return plan;
}

export function assertTerminalPlan(plan, signer) {
  if (plan?.meta?.kind !== 'ckeyBatchTransfer' || plan.meta.channel !== TERMINAL_CHANNEL) {
    throw new Error('这不是终端空投计划。浏览器计划请用 npm run ckey:batch-transfer -- --resume');
  }
  if (plan.chainId !== 56) throw new Error('计划不是 BSC 主网');
  if (getAddress(plan.signer) !== getAddress(signer)) throw new Error('计划签名地址与 CKEY_AIRDROP_PRIVATE_KEY 不一致');
  return plan;
}

/** Balance, allowlist and gas ceiling for one CKEY transfer per row. */
export async function inspectAirdrop({ client, token, from, rows }) {
  const total = rows.reduce((sum, row) => sum + row.amount, 0n);
  const [code, paused, enabled, listed, balance, decimals, bnb, gasPrice] = await Promise.all([
    client.getCode({ address: from }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'paused' }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'transfersEnabled' }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'transferAllowlist', args: [from] }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [from] }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'decimals' }),
    client.getBalance({ address: from }),
    client.getGasPrice(),
  ]);
  if (decimals !== 18) throw new Error('代币精度不是 18');
  assertCanSend({ code, paused, enabled, listed, balance, total });
  let gas = 0n;
  for (const row of rows) {
    const estimate = await client.estimateContractGas({ address: token, abi: TOKEN_ABI, functionName: 'transfer', args: [row.to, row.amount], account: from });
    gas += (estimate * 3n) / 2n;
  }
  const gasBudget = gas * gasPrice;
  if (bnb < gasBudget) throw new Error(`BNB 不足，当前估算上限 ${formatUnits(gasBudget, 18)} BNB`);
  return { total, balance, gasBudget, paused, enabled, listed };
}

/**
 * Sign each planned CKEY transfer locally and record it after 3 confirmations.
 * `afterBroadcast` runs before the receipt wait so tests can change chain state.
 */
export async function sendPlannedTransfers({ path, client, db, account, token, afterBroadcast } = {}) {
  const plan = assertTerminalPlan(readPlan(path), account.address);
  let disconnected = false;
  const onError = () => { disconnected = true; };
  db.on('error', onError);
  try {
    await lockAirdrop(db, token);
    await reserveBatch(db, plan, token);
    for (let index = 0; index < plan.txs.length; index++) await settle(index, { mined: Boolean(plan.txs[index].hash) });
    for (let index = 0; index < plan.txs.length; index++) {
      const tx = plan.txs[index];
      if (tx.status === 'success' && tx.recorded) continue;
      if (tx.hash) continue;
      await reserveNonce(index);
      const hash = await broadcast(index);
      tx.hash = hash;
      writePlan(path, plan);
      console.log(`第 ${index + 1}/${plan.txs.length} 笔已广播 ${hash}`);
      if (afterBroadcast) await afterBroadcast({ plan, index, hash });
      await settle(index, { mined: true });
    }
    if (plan.txs.some((tx) => tx.status !== 'success' || !tx.recorded)) throw new Error('尚有交易待核验或待登记');
    return plan;
  } finally {
    db.removeListener('error', onError);
  }

  async function settle(index, { mined }) {
    const tx = plan.txs[index];
    if (!tx.hash) return;
    if (disconnected) throw new Error('数据库连接已断开，停止签名；恢复原计划');
    const receipt = await client.waitForTransactionReceipt({ hash: tx.hash, confirmations: 3 });
    if (receipt.status === 'reverted') {
      await recoverReverted(db, client, plan, index, token, receipt);
      writePlan(path, plan);
      throw new Error(`第 ${index + 1} 笔已回滚。恢复原计划会按相同 transfer 重发：${path}`);
    }
    await recordConfirmed(db, client, plan, index, token);
    writePlan(path, plan);
    if (mined) console.log(`第 ${index + 1}/${plan.txs.length} 笔已核验并登记 ${tx.hash}`);
  }

  async function reserveNonce(index) {
    if (disconnected) throw new Error('数据库连接已断开，停止签名；恢复原计划');
    if (plan.txs.slice(0, index).some((tx) => !tx.recorded)) throw new Error('前一笔尚未完成链上核验及入库');
    const tx = plan.txs[index];
    const row = planRows(plan, token)[index];
    const code = await client.getCode({ address: getAddress(plan.signer) });
    if (code && code !== '0x') throw new Error('当前工具仅支持普通 EOA 转出账户');
    const decimals = await client.readContract({ address: token, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' });
    if (decimals !== 18) throw new Error('CKEY 精度不是 18');
    const intent = (await db.query('SELECT * FROM activity_airdrop_intents WHERE "batchId"=$1 AND "recipientKey"=$2', [plan.meta.batchId, row.key])).rows[0];
    if (!intent || intent.status === 'confirmed') throw new Error('发放占位不存在或已确认，请恢复计划补登记');
    const latest = await client.getTransactionCount({ address: getAddress(plan.signer), blockTag: 'latest' });
    const pending = await client.getTransactionCount({ address: getAddress(plan.signer), blockTag: 'pending' });
    let nonce;
    if (intent.nonce !== null) {
      nonce = Number(intent.nonce);
      if (latest > nonce || pending > nonce) throw new Error(`nonce ${nonce} 已使用或有待确认交易；用 --record-only 核实原交易，禁止新 nonce 重发`);
    } else {
      if (latest !== pending) throw new Error('转出账户有待确认交易，先等该交易确认');
      nonce = latest;
      await db.query('UPDATE activity_airdrop_intents SET status=\'signing\', nonce=$1, "updatedAt"=now() WHERE "batchId"=$2 AND "recipientKey"=$3', [nonce, plan.meta.batchId, row.key]);
    }
    tx.nonce = nonce;
    writePlan(path, plan);
  }

  async function broadcast(index) {
    const tx = plan.txs[index];
    const to = getAddress(tx.to);
    if (to !== getAddress(token)) throw new Error('计划的代币不是当前 CKEY');
    const estimate = await client.estimateGas({ account: account.address, to, data: tx.data, value: 0n });
    const gas = (estimate * 3n) / 2n;
    const gasPrice = await client.getGasPrice();
    const serializedTransaction = await account.signTransaction({
      chainId: 56, nonce: tx.nonce, to, data: tx.data, value: 0n, gas, gasPrice, type: 'legacy',
    });
    return client.sendRawTransaction({ serializedTransaction });
  }
}
