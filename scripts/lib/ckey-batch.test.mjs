import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { activityCode, tokenAmount, parseBatchCsv, batchTransferPlan, contentFingerprint } from './ckey-batch.mjs';
import { verifyTransfer, immutableManifest, filterRecipients } from './ckey-airdrop-record.mjs';
import { serveBatchUpload } from './ckey-batch-page.mjs';
const A='0x1111111111111111111111111111111111111111', B='0x2222222222222222222222222222222222222222', FROM='0x3333333333333333333333333333333333333333', TOKEN='0x4444444444444444444444444444444444444444';
const ONE=10n**18n;
const csv=`address,amount\n${A},100\n${B},100.5`;
const parsed=()=>parseBatchCsv(csv,FROM,'社区互动.csv');
const plan=()=>batchTransferPlan({from:FROM,token:TOKEN,...parsed(),code:activityCode('社区互动')});
test('decimal token input preserves all 18 digits and rejects ambiguous formats',()=>{
  assert.equal(tokenAmount('100'),100n*ONE); assert.equal(tokenAmount('100.000000000000000001'),100n*ONE+1n);
  for(const v of ['0','-1','1e18','100,000','NaN','0.0000000000000000001','1.','1.1234567890123456789', '9'.repeat(80)]) assert.throws(()=>tokenAmount(v));
});
test('filename names campaign, duplicate lines merge, conflicting amounts block',()=>{
  const p=parseBatchCsv(csv+`\n${A},100`,FROM,'社区互动.csv');
  assert.equal(p.name,'社区互动'); assert.equal(p.rows.length,2); assert.equal(p.duplicates.length,1);
  assert.throws(()=>parseBatchCsv(csv+`\n${A},101`,FROM,'社区互动.csv'),/冲突/);
  assert.throws(()=>parseBatchCsv(`活动,旧格式\n${A},1e18`,FROM,'社区互动.csv'));
  assert.throws(()=>parseBatchCsv(csv,FROM,'社区互动.csv',{expectedAmount:100n*ONE}),/不是本批/);
  assert.equal(contentFingerprint([...p.rows].reverse()),p.fingerprint);
  assert.equal(activityCode('社区互动'),activityCode('社区互动'));
  assert.notEqual(activityCode('社区互动'),activityCode('现场活动'));
});
test('immutable batch manifest ignores status but catches recipient or repeat-policy changes',()=>{
  const p=plan(), before=immutableManifest(p);
  p.txs[0].status='success'; p.txs[0].nonce=3;
  assert.deepEqual(immutableManifest(p),before);
  const mutated=structuredClone(p); mutated.meta.allowRepeat=true;
  assert.notDeepEqual(immutableManifest(mutated),before);
});
test('receipt must contain exactly one matching token Transfer',()=>{
  const p=plan(), abi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log={address:TOKEN,logIndex:2,topics:encodeEventTopics({abi,eventName:'Transfer',args:{from:FROM,to:A}}),data:encodeAbiParameters([{type:'uint256'}],[100n*ONE])};
  assert.equal(verifyTransfer(p,0,{status:'success',logs:[log]},TOKEN).amountWei,String(100n*ONE));
  assert.throws(()=>verifyTransfer(p,0,{status:'success',logs:[]},TOKEN));
  assert.throws(()=>verifyTransfer(p,0,{status:'success',logs:[log,log]},TOKEN));
  assert.throws(()=>verifyTransfer(p,0,{status:'reverted',logs:[log]},TOKEN));
  assert.throws(()=>verifyTransfer(p,0,{status:'success',logs:[{...log,address:B}]},TOKEN));
});
test('default excludes all historic recipients; override only permits other completed campaigns',async()=>{
  const db={query:async()=>({rows:[{key:A.toLowerCase(),code:'old',status:'confirmed',batch:''}]})};
  assert.equal((await filterRecipients(db,{rows:parsed().rows,code:'new',allowRepeat:false,token:TOKEN})).rows.length,1);
  assert.equal((await filterRecipients(db,{rows:parsed().rows,code:'new',allowRepeat:true,token:TOKEN})).rows.length,2);
  assert.equal((await filterRecipients(db,{rows:parsed().rows,code:'old',allowRepeat:true,token:TOKEN})).rows.length,1);
  db.query=async()=>({rows:[{key:A.toLowerCase(),code:'old',status:'signing',batch:'pending-batch'}]});
  await assert.rejects(()=>filterRecipients(db,{rows:parsed().rows,code:'new',allowRepeat:true,token:TOKEN}),/未完成/);
});
test('upload previews human units and requires confirmation',async()=>{
  let ready; const listening=new Promise(r=>ready=r);
  const job=serveBatchUpload({port:18793,openBrowser:false,keepAlive:false,ready,
    inspect:async p=>({balance:1000n*ONE,balanceTokens:'1000',totalTokens:String(Number(p.total)/1e18),listed:true,enabled:false})});
  await listening;
  const html=await(await fetch('http://127.0.0.1:18793/')).text();
  const token=html.match(/const TOKEN="([0-9a-f]+)"/)[1];
  const post=(path,body)=>fetch(`http://127.0.0.1:18793${path}`,{method:'POST',headers:{'content-type':'application/json','x-sign-token':token},body:JSON.stringify(body)});
  const pre=await(await post('/preview',{from:FROM,csv,filename:'社区互动.csv'})).json();
  assert.equal(pre.rows[0].tokens,'100'); assert.equal(pre.name,'社区互动');
  assert.equal((await post('/start',{previewId:pre.previewId,ack:false})).status,409);
  assert.equal((await post('/start',{previewId:pre.previewId,ack:true})).status,200);
  assert.equal((await job).rows[0].amount,100n*ONE);
});
