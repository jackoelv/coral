#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { formatUnits, parseAbi } from 'viem';
import { activityCode, assertCanSend, batchTransferPlan, tokenAmount } from './lib/ckey-batch.mjs';
import { serveBatchUpload } from './lib/ckey-batch-page.mjs';
import { openAirdropDb, filterRecipients, recordCkeyAirdrop } from './lib/ckey-airdrop-record.mjs';
import { runAirdrop } from './lib/ckey-airdrop-run.mjs';
import { ROOT, contracts, mainnetClient, readMainnetEnv, redact, runPath, stamp } from './lib/mainnet.mjs';
import { writePlan } from './lib/sign-plan.mjs';

const argv = process.argv.slice(2);
const options = new Set(['--allow-repeat','--csv','--campaign-code','--expected-amount','--resume','--record-only','--port','--sign-port','--help']);
const flag = n => argv.includes(n);
function value(n) { const i=argv.indexOf(n); if(i<0) return null; if(!argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`${n} 缺少参数`); return argv[i+1]; }
function port(n, fallback) { const p=Number(value(n) || fallback); if(!Number.isInteger(p)||p<1||p>65535) throw new Error('端口无效'); return p; }
let env = {};
async function main() {
  for(let i=0;i<argv.length;i++) { if(!options.has(argv[i])) throw new Error(`未知参数 ${argv[i]}`); if(!['--allow-repeat','--help'].includes(argv[i])) i++; }
  if(flag('--help')) { console.log(`npm run ckey:batch-transfer -- [--csv activity/活动名称.csv] [--expected-amount 100] [--allow-repeat]\n续签：--resume <计划路径>；仅补登记：--record-only <计划路径>\nCSV: address,amount；100 表示 100 CKEY。默认跳过任何历史已获空投地址。--allow-repeat 仅允许跨活动再次发放。\n同一活动分批请用 --campaign-code <已有活动编号>，且保持相同文件名。`); return; }
  if(flag('--resume') || flag('--record-only')) {
    if(flag('--resume') && flag('--record-only') || flag('--allow-repeat') || flag('--csv') || flag('--campaign-code') || flag('--expected-amount')) throw new Error('恢复时不能改变原计划参数');
    env=readMainnetEnv();
    const path=resolve(value('--resume') || value('--record-only'));
    if(flag('--record-only')) await recordCkeyAirdrop(path, env); else await runAirdrop(path, env, {port:port('--sign-port',8756)});
    return;
  }
  env=readMainnetEnv();
  const client=await mainnetClient(env), token=contracts(env).CKEY, db=await openAirdropDb(env);
  const allowRepeat=flag('--allow-repeat');
  let preset;
  if(flag('--csv')) {
    const root=realpathSync(resolve(ROOT,'activity')), file=realpathSync(resolve(ROOT,value('--csv')));
    if(!file.startsWith(root+sep) || !/\.csv$/i.test(file)) throw new Error('CSV 必须位于 coral/activity/');
    preset={filename:basename(file),csv:readFileSync(file,'utf8')};
  }
  const abi=parseAbi(['function paused() view returns (bool)','function transfersEnabled() view returns (bool)','function transferAllowlist(address) view returns (bool)','function balanceOf(address) view returns (uint256)','function decimals() view returns (uint8)','function transfer(address to,uint256 amount) returns (bool)']);
  let job;
  try {
    job=await serveBatchUpload({ port:port('--port',8759), preset, allowRepeat,
      expectedAmount: flag('--expected-amount') ? tokenAmount(value('--expected-amount')) : null,
      inspect: async input => {
        const code=value('--campaign-code') || activityCode(input.name);
        const selected=await filterRecipients(db,{...input,code,allowRepeat,token});
        if(!selected.rows.length) throw new Error('全部地址已发放，本次没有可发送地址');
        const total=selected.rows.reduce((s,r)=>s+r.amount,0n);
        const [accountCode,paused,enabled,listed,balance,decimals,bnb,gasPrice]=await Promise.all([
          client.getCode({address:input.from}),client.readContract({address:token,abi,functionName:'paused'}),
          client.readContract({address:token,abi,functionName:'transfersEnabled'}),client.readContract({address:token,abi,functionName:'transferAllowlist',args:[input.from]}),
          client.readContract({address:token,abi,functionName:'balanceOf',args:[input.from]}),client.readContract({address:token,abi,functionName:'decimals'}),client.getBalance({address:input.from}),client.getGasPrice(),
        ]);
        if(decimals!==18) throw new Error('代币精度不是 18');
        assertCanSend({code:accountCode,paused,enabled,listed,balance,total});
        let gas=0n;
        for(const row of selected.rows) {
          const estimate=await client.estimateContractGas({address:token,abi,functionName:'transfer',args:[row.to,row.amount],account:input.from});
          gas += estimate*3n/2n;
        }
        const gasBudget=gas*gasPrice;
        if(bnb<gasBudget) throw new Error(`BNB 不足，当前估算上限 ${formatUnits(gasBudget,18)} BNB`);
        return { ...selected,code,total,paused,enabled,listed,balance,balanceTokens:formatUnits(balance,18),totalTokens:formatUnits(total,18),gasBudget:formatUnits(gasBudget,18),token };
      },
    });
  } finally { await db.end(); }
  const plan=batchTransferPlan({...job,token,allowRepeat});
  const path=runPath('plans',`ckey-batch-${stamp()}-${plan.meta.batchId}.json`);
  writePlan(path,plan);
  console.log(`计划 ${path}\n恢复：npm run ckey:batch-transfer -- --resume '${path}'`);
  await runAirdrop(path,env,{port:port('--sign-port',8756)});
}
main().catch(e=>{ console.error(redact(e.shortMessage||e.message||String(e),env)); process.exitCode=1; });
