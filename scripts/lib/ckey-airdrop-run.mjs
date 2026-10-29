import { getAddress, parseAbi } from 'viem';
import { contracts, need, mainnetClient } from './mainnet.mjs';
import { readPlan, writePlan } from './sign-plan.mjs';
import { servePlan } from './sign-server.mjs';
import { lockAirdrop, openAirdropDb, planRows, reserveBatch, recordConfirmed, recoverReverted } from './ckey-airdrop-record.mjs';

export async function runAirdrop(path, env, { port = 8756 } = {}) {
  const token = contracts(env).CKEY, client = await mainnetClient(env), db = await openAirdropDb(env);
  let disconnected = false;
  db.on('error', () => { disconnected = true; });
  try {
    await lockAirdrop(db, token);
    const plan = readPlan(path);
    await reserveBatch(db, plan, token);
    // Reverify stored successes too. A local status flag alone is never proof.
    for (let i=0; i<plan.txs.length; i++) {
      if (plan.txs[i].hash) {
        const tx = plan.txs[i];
        const receipt = await client.waitForTransactionReceipt({ hash: tx.hash, confirmations: 3 });
        if (receipt.status === 'reverted') {
          await recoverReverted(db,client,plan,i,token,receipt);
        } else await recordConfirmed(db, client, plan, i, token);
        writePlan(path, plan);
      }
      else if (plan.txs[i].status === 'success') throw new Error('成功标记缺少哈希');
    }
    const beforeSend = async ({ plan, index, tx }) => {
      if (disconnected) throw new Error('数据库连接已断开，停止签名；恢复原计划');
      if (plan.txs.slice(0,index).some(t => !t.recorded)) throw new Error('前一笔尚未完成链上核验及入库');
      const row = planRows(plan, token)[index];
      const code = await client.getCode({ address: getAddress(plan.signer) });
      if (code && code !== '0x') throw new Error('当前工具仅支持普通 EOA 转出账户');
      const decimals = await client.readContract({ address: token, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' });
      if (decimals !== 18) throw new Error('CKEY 精度不是 18');
      const result = await db.query('SELECT * FROM activity_airdrop_intents WHERE "batchId"=$1 AND "recipientKey"=$2', [plan.meta.batchId,row.key]);
      const intent = result.rows[0];
      if (!intent || intent.status === 'confirmed') throw new Error('发放占位不存在或已确认，请恢复计划补登记');
      const latest = await client.getTransactionCount({ address: getAddress(plan.signer), blockTag: 'latest' });
      const pending = await client.getTransactionCount({ address: getAddress(plan.signer), blockTag: 'pending' });
      let nonce;
      if (intent.nonce !== null) {
        nonce = Number(intent.nonce);
        if (latest > nonce || pending > nonce) throw new Error(`nonce ${nonce} 已使用或有待确认交易；填原交易哈希核实，禁止新 nonce 重发`);
      } else {
        if (latest !== pending) throw new Error('转出账户有待确认交易，先等该交易确认');
        nonce = latest;
        await db.query('UPDATE activity_airdrop_intents SET status=\'signing\', nonce=$1, "updatedAt"=now() WHERE "batchId"=$2 AND "recipientKey"=$3', [nonce,plan.meta.batchId,row.key]);
      }
      tx.nonce = nonce;
      return { nonce: `0x${nonce.toString(16)}` };
    };
    await servePlan(path, { rpc: need(env,'BSC_MAINNET_RPC'), allowed: [token], port,
      walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || '', beforeSend,
      onConfirmed: async ({ plan, index }) => { await recordConfirmed(db,client,plan,index,token); },
    });
    const result = readPlan(path);
    if (result.txs.some(t => t.status !== 'success' || !t.recorded)) throw new Error('尚有交易待核验或待登记');
    console.log(`全部 ${result.txs.length} 笔已核验并登记 production。计划：${path}`);
  } finally { await db.end(); }
}
