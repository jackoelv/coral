/** Explicit local integration test: fixed loopback ports, no .env reads or real keys. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createPublicClient, http, encodeDeployData, encodeFunctionData, getAddress } from 'viem';
import { parseBatchCsv, batchTransferPlan, activityCode } from './lib/ckey-batch.mjs';
import { reserveBatch, lockAirdrop, filterRecipients, recordConfirmed, recoverReverted } from './lib/ckey-airdrop-record.mjs';
const url='postgres://ckey_test@127.0.0.1:55438/ckey_test';
const db=new pg.Client({connectionString:url}), other=new pg.Client({connectionString:url});
const chain=createPublicClient({transport:http('http://127.0.0.1:18548'),pollingInterval:20});
await db.connect(); await other.connect();
try {
  const tables=['activity_airdrop_intents','activity_airdrop_batches','activity_airdrop_transfers','activity_airdrop_campaigns'];
  for(const table of tables) await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  for(const file of ['002-ckey-airdrop.sql','003-ckey-airdrop-recovery.sql']) await db.query(readFileSync(new URL(`../mainnet/${file}`,import.meta.url),'utf8'));
  // Migrations must be rerunnable without destroying history.
  await db.query(readFileSync(new URL('../mainnet/003-ckey-airdrop-recovery.sql',import.meta.url),'utf8'));
  const accounts=await chain.request({method:'eth_accounts'}), sender=getAddress(accounts[0]), A=getAddress(accounts[1]), B=getAddress(accounts[2]);
  const artifact=JSON.parse(readFileSync(new URL('../out/CoralToken.sol/CoralToken.json',import.meta.url),'utf8'));
  const send=async(data,to)=>{
    const hash=await chain.request({method:'eth_sendTransaction',params:[{from:sender,...(to?{to}:{}),data,gas:'0x7a1200'}]});
    await chain.request({method:'anvil_mine',params:['0x3']});
    const receipt=await chain.waitForTransactionReceipt({hash,confirmations:3});
    assert.equal(receipt.status,'success'); return receipt;
  };
  const token=getAddress((await send(encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[sender]}))).contractAddress);
  await send(encodeFunctionData({abi:artifact.abi,functionName:'mint',args:[sender,10000n*10n**18n]}),token);
  await send(encodeFunctionData({abi:artifact.abi,functionName:'setTransferAllowlist',args:[sender,true]}),token);
  const parsed=parseBatchCsv(`address,amount\n${A},100\n${B},100.000000000000000001`,sender,'本地验收.csv');
  const make=(name,rows=parsed.rows,allowRepeat=false)=>batchTransferPlan({from:sender,token,rows,name,code:activityCode(name),allowRepeat});
  const plan=make('本地验收');
  await lockAirdrop(db,token);
  await assert.rejects(()=>lockAirdrop(other,token),/正在运行/);
  await reserveBatch(db,plan,token);
  await reserveBatch(db,plan,token); // resume is idempotent
  const tampered=structuredClone(plan); tampered.meta.allowRepeat=true;
  await assert.rejects(()=>reserveBatch(db,tampered,token),/已变动/);
  await assert.rejects(()=>reserveBatch(db,make('另一场',parsed.rows,true),token),/未完成/);
  const reserveNonce=async(p,i)=>{
    const nonce=await chain.getTransactionCount({address:sender});
    const row=p.txs[i]; row.nonce=nonce;
    const recipient=i===1 ? B : A;
    await db.query('UPDATE activity_airdrop_intents SET nonce=$1,status=\'signing\' WHERE "batchId"=$2 AND "recipientKey"=$3',[nonce,p.meta.batchId,recipient.toLowerCase()]);
  };
  await reserveNonce(plan,0);
  const r=await send(plan.txs[0].data,token); plan.txs[0].hash=r.transactionHash;
  await recordConfirmed(db,chain,plan,0,token);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM activity_airdrop_transfers')).rows[0].n,1,'partial batch immediately recorded');
  await recordConfirmed(db,chain,plan,0,token);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM activity_airdrop_transfers')).rows[0].n,1,'repair never double counts');
  const completed=(await filterRecipients(db,{rows:[parsed.rows[0]],code:activityCode('其他活动'),allowRepeat:false,token}));
  assert.equal(completed.rows.length,0);
  assert.equal((await filterRecipients(db,{rows:[parsed.rows[0]],code:plan.meta.code,allowRepeat:true,token})).rows.length,0);
  await reserveNonce(plan,1);
  const second=await send(plan.txs[1].data,token); plan.txs[1].hash=second.transactionHash;
  // Inject a DB failure after chain success. Reconciliation must repair without sending.
  const broken={query:async()=>{throw new Error('database offline')}};
  await assert.rejects(()=>recordConfirmed(broken,chain,plan,1,token),/offline/);
  await recordConfirmed(db,chain,plan,1,token);
  const repeat=make('允许再次参与',[parsed.rows[0]],true); await reserveBatch(db,repeat,token);
  await reserveNonce(repeat,0);
  const third=await send(repeat.txs[0].data,token); repeat.txs[0].hash=third.transactionHash;
  await recordConfirmed(db,chain,repeat,0,token);
  assert.equal((await db.query('SELECT sum("amountWei"::numeric)::text AS n FROM activity_airdrop_transfers')).rows[0].n,'300000000000000000001');
  assert.equal(await chain.readContract({address:token,abi:artifact.abi,functionName:'balanceOf',args:[A]}),200n*10n**18n);
  assert.equal(await chain.readContract({address:token,abi:artifact.abi,functionName:'balanceOf',args:[B]}),100n*10n**18n+1n);
  // A wrong historical reverted hash must not release a currently reserved nonce.
  await send(encodeFunctionData({abi:artifact.abi,functionName:'pause'}),token);
  const retry=make('失败后恢复',[parsed.rows[0]],true); await reserveBatch(db,retry,token); await reserveNonce(retry,0);
  const failedHash=await chain.request({method:'eth_sendTransaction',params:[{from:sender,to:token,data:retry.txs[0].data,gas:'0x200000'}]});
  await chain.request({method:'anvil_mine',params:['0x3']});
  const failedReceipt=await chain.waitForTransactionReceipt({hash:failedHash,confirmations:3});
  assert.equal(failedReceipt.status,'reverted'); retry.txs[0].hash=failedHash;
  const expectedNonce=retry.txs[0].nonce;
  await db.query('UPDATE activity_airdrop_intents SET nonce=$1 WHERE "batchId"=$2',[expectedNonce+1,retry.meta.batchId]);
  await assert.rejects(()=>recoverReverted(db,chain,retry,0,token,failedReceipt),/nonce/);
  await db.query('UPDATE activity_airdrop_intents SET nonce=$1 WHERE "batchId"=$2',[expectedNonce,retry.meta.batchId]);
  await recoverReverted(db,chain,retry,0,token,failedReceipt);
  assert.equal(retry.txs[0].hash,null);
  await send(encodeFunctionData({abi:artifact.abi,functionName:'unpause'}),token);
  await reserveNonce(retry,0);
  retry.txs[0].hash=(await send(retry.txs[0].data,token)).transactionHash;
  await recordConfirmed(db,chain,retry,0,token);
  const verified=(await db.query('SELECT count(*)::int AS n FROM activity_airdrop_transfers WHERE "verifiedAt" IS NOT NULL AND "blockTimestamp" IS NOT NULL')).rows[0].n;
  assert.equal(verified,4);
  console.log(JSON.stringify({ok:true,scope:'local Anvil + isolated PostgreSQL only',checks:['migration rerun','concurrent executor lock','immutable resume','pending repeat blocked','partial batch recorded','idempotent repair','default historic skip','same campaign repeat blocked','DB outage after successful receipt','explicit different campaign repeat','18-digit precision','Transfer receipts and chain balances','reverted retry only releases matching reserved nonce'],transfers:verified}));
} finally { await db.end(); await other.end(); }
