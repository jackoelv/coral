#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { formatUnits } from 'viem';
import { activityCode, batchTransferPlan, parseBatchCsv, tokenAmount } from './lib/ckey-batch.mjs';
import { openAirdropDb, filterRecipients, recordCkeyAirdrop } from './lib/ckey-airdrop-record.mjs';
import { airdropAccount, asTerminalPlan, assertTerminalPlan, inspectAirdrop, sendPlannedTransfers } from './lib/ckey-batch-send.mjs';
import { ROOT, confirmTyped, contracts, mainnetClient, readMainnetEnv, redact, runPath, stamp } from './lib/mainnet.mjs';
import { readPlan, writePlan } from './lib/sign-plan.mjs';

const argv = process.argv.slice(2);
const options = new Set(['--allow-repeat', '--csv', '--campaign-code', '--expected-amount', '--resume', '--record-only', '--apply', '--help']);
const flag = (name) => argv.includes(name);
function value(name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return argv[index + 1];
}
let env = {};

async function main() {
  for (let i = 0; i < argv.length; i++) {
    if (!options.has(argv[i])) throw new Error(`未知参数 ${argv[i]}`);
    if (!['--allow-repeat', '--apply', '--help'].includes(argv[i])) i++;
  }
  if (flag('--help')) {
    console.log(`npm run ckey:batch-send -- --csv activity/活动名称.csv [--expected-amount 100] [--allow-repeat] [--apply]
不带 --apply 只预览并写出计划。--apply 用 .env.mainnet 的 CKEY_AIRDROP_PRIVATE_KEY 逐笔签名 CKEY transfer。
续发：--resume <计划路径> --apply；仅补登记：--record-only <计划路径>
CSV: address,amount；100 表示 100 CKEY。默认跳过任何历史已获空投地址。--allow-repeat 仅允许跨活动再次发放。
同一活动分批请用 --campaign-code <已有活动编号>，且保持相同文件名。浏览器计划不能用本命令恢复。`);
    return;
  }
  if (flag('--record-only') && (flag('--apply') || flag('--resume'))) throw new Error('补登记不要加 --apply 或 --resume');
  if (flag('--resume') || flag('--record-only')) {
    if (flag('--allow-repeat') || flag('--csv') || flag('--campaign-code') || flag('--expected-amount')) throw new Error('恢复时不能改变原计划参数');
    env = readMainnetEnv();
    const path = resolve(value('--resume') || value('--record-only'));
    const account = airdropAccount(env);
    assertTerminalPlan(readPlan(path), account.address);
    if (flag('--record-only')) {
      await recordCkeyAirdrop(path, env);
      console.log(`已按链上结果补登记。计划：${path}`);
      return;
    }
    if (!flag('--apply')) {
      console.log(`计划 ${path}\n广播：npm run ckey:batch-send -- --resume '${path}' --apply`);
      return;
    }
    const plan = readPlan(path);
    if (plan.txs.some((tx) => !tx.hash)) await confirmTyped('SEND CKEY', `即将用 ${account.address} 继续广播尚未发送的 CKEY transfer`);
    const db = await openAirdropDb(env);
    try {
      await sendPlannedTransfers({ path, client: await mainnetClient(env), db, account, token: contracts(env).CKEY });
    } finally {
      await db.end();
    }
    console.log(`全部已核验并登记 production。计划：${path}`);
    return;
  }
  if (!flag('--csv')) throw new Error('请用 --csv activity/活动名称.csv');
  env = readMainnetEnv();
  const account = airdropAccount(env);
  const client = await mainnetClient(env);
  const token = contracts(env).CKEY;
  const allowRepeat = flag('--allow-repeat');
  const db = await openAirdropDb(env);
  let plan;
  let planPath;
  try {
    const root = realpathSync(resolve(ROOT, 'activity'));
    const file = realpathSync(resolve(ROOT, value('--csv')));
    if (!file.startsWith(root + sep) || !/\.csv$/i.test(file)) throw new Error('CSV 必须位于 coral/activity/');
    const parsed = parseBatchCsv(readFileSync(file, 'utf8'), account.address, basename(file), {
      expectedAmount: flag('--expected-amount') ? tokenAmount(value('--expected-amount')) : null,
    });
    const code = value('--campaign-code') || activityCode(parsed.name);
    const selected = await filterRecipients(db, { rows: parsed.rows, code, allowRepeat, token });
    if (!selected.rows.length) throw new Error('全部地址已发放，本次没有可发送地址');
    const inspection = await inspectAirdrop({ client, token, from: account.address, rows: selected.rows });
    plan = asTerminalPlan(batchTransferPlan({
      from: account.address, token, rows: selected.rows, code, name: parsed.name, allowRepeat,
      fingerprint: parsed.fingerprint, duplicates: parsed.duplicates, skipped: selected.skipped,
    }));
    planPath = runPath('plans', `ckey-send-${stamp()}-${plan.meta.batchId}.json`);
    writePlan(planPath, plan);
    console.log(`预览 ${parsed.name}：${selected.rows.length} 笔，合计 ${formatUnits(inspection.total, 18)} CKEY`);
    console.log(`转出 ${account.address}`);
    console.log(`跳过 ${selected.skipped.length}，合并重复 ${parsed.duplicates.length}`);
    for (const dup of parsed.duplicates) console.log(`第 ${dup.line} 行与第 ${dup.firstLine} 行相同，地址 ${dup.to}，只保留第 ${dup.firstLine} 行`);
    console.log(`Gas 预算上限 ${formatUnits(inspection.gasBudget, 18)} BNB`);
    console.log(`计划 ${planPath}`);
  } finally {
    await db.end();
  }
  if (!flag('--apply')) {
    console.log(`广播：npm run ckey:batch-send -- --resume '${planPath}' --apply`);
    return;
  }
  await confirmTyped('SEND CKEY', `即将用 ${account.address} 广播 ${plan.txs.length} 笔 CKEY transfer，合计 ${formatUnits(BigInt(plan.meta.total), 18)} CKEY`);
  const sendDb = await openAirdropDb(env);
  try {
    await sendPlannedTransfers({ path: planPath, client, db: sendDb, account, token });
  } finally {
    await sendDb.end();
  }
  console.log(`全部 ${plan.txs.length} 笔已核验并登记 production。计划：${planPath}`);
}

main().catch((error) => {
  console.error(redact(error.shortMessage || error.message || String(error), env));
  process.exitCode = 1;
});
