#!/usr/bin/env node
// Explicit, backup-gated migration. Never invoked by the transfer tool.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { readMainnetEnv, need, productionDatabase, sha256File, confirmTyped, ROOT, redact } from './lib/mainnet.mjs';
const args=process.argv.slice(2), index=args.indexOf('--backup');
let env={};
async function main() {
  if(index<0 || !args[index+1]) throw new Error('用法：npm run ckey:airdrop:migrate -- --backup <已通过恢复测试的备份> [--apply]');
  const backup=resolve(args[index+1]);
  env=readMainnetEnv();
  const url=need(env,'DATABASE_URL_UNPOOLED'), target=productionDatabase(url);
  if(!existsSync(backup) || !existsSync(`${backup}.restore-ok.json`)) throw new Error('缺少已验证的备份');
  const ok=JSON.parse(readFileSync(`${backup}.restore-ok.json`,'utf8')), info=JSON.parse(readFileSync(`${backup}.json`,'utf8'));
  const age=Date.now()-Date.parse(info.finished);
  if(!ok.ok || ok.sha256!==sha256File(backup) || info.host!==target.host || info.database!==target.database || !Number.isFinite(age) || age<0 || age>86400000) throw new Error('备份目标、校验或时效不符合要求');
  const sql=['002-ckey-airdrop.sql','003-ckey-airdrop-recovery.sql'].map(file=>readFileSync(resolve(ROOT,'mainnet',file),'utf8')).join('\n');
  console.log(JSON.stringify({target:target.database,migrations:['002-ckey-airdrop.sql','003-ckey-airdrop-recovery.sql'],backupVerified:true,apply:args.includes('--apply')}));
  if(!args.includes('--apply')) return;
  await confirmTyped('MIGRATE AIRDROP', '仅增加空投表与恢复字段；不发送交易，不删除历史记录');
  const db=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:true}}); await db.connect();
  try { await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout = '5s'"); await db.query(sql); await db.query('COMMIT'); }
  catch(e) { await db.query('ROLLBACK'); throw e; } finally { await db.end(); }
  console.log('空投迁移完成');
}
main().catch(e=>{console.error(redact(e.message,env));process.exitCode=1;});
