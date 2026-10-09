#!/usr/bin/env node
// Read-only: no wallet client, no private key access, no database connection.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createPublicClient, getAddress, http, parseAbi, zeroAddress } from 'viem';
import { creationReceipt, validateCreation } from './lib/deployment-receipt.mjs';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (!args.includes('--env') || !value('--env') || value('--env').startsWith('--')) {
  throw new Error('用法: node scripts/verify-mainnet.mjs --env /绝对路径/.env.mainnet --stage deployed|ready');
}
const config = parseEnv(readFileSync(value('--env'), 'utf8'));
const stage = args.includes('--stage') ? value('--stage') : 'deployed';
if (!['deployed', 'ready'].includes(stage)) throw new Error('stage 必须是 deployed 或 ready');
const need = name => { if (!config[name]?.trim()) throw new Error(`缺少 ${name}`); return config[name].trim(); };
if (need('CHAIN_ID') !== '56' || need('NETWORK') !== 'bscMainnet') throw new Error('必须显式配置 chain 56 / bscMainnet');
const address = name => { const a = getAddress(need(name)); if (a === zeroAddress) throw new Error(`${name} 不能为零`); return a; };
const names = ['USDT', 'CKEY', 'NFT', 'IDO', 'REWARDS', 'INTEREST'];
const a = Object.fromEntries(names.map(n => [n, address(`BSC_MAINNET_${n}`)]));
if (a.USDT !== getAddress('0x55d398326f99059fF775485246999027B3197955')) throw new Error('USDT 不是 BSC 官方地址');
if (new Set(Object.values(a)).size !== 6) throw new Error('合约地址重复');
const owner = address('EXPECTED_OWNER');
const client = createPublicClient({ transport: http(need('BSC_MAINNET_RPC'), { retryCount: 1, timeout: 15000 }) });
if (await client.getChainId() !== 56) throw new Error('RPC 不是 chainId 56，停止');
const block = await client.getBlock();
const results = [];
const failures = [];
const printable = v => typeof v === 'bigint' ? v.toString() : v;
function check(name, actual, expected) {
  const ok = typeof actual === 'string' && typeof expected === 'string' && actual.startsWith('0x')
    ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  results.push({ name, actual: printable(actual), expected: printable(expected), ok });
  if (!ok) failures.push(name);
}
const read = (key, fn, type = 'address') => client.readContract({ address: a[key], abi: parseAbi([`function ${fn}() view returns (${type})`]), functionName: fn, blockNumber: block.number });
if (args.includes('--broadcast')) {
  const run = JSON.parse(readFileSync(value('--broadcast'), 'utf8'));
  if (Number(run.chain) !== 56 || !run.receipts?.length) throw new Error('部署记录不是 chain56 或没有回执');
  for (const receipt of run.receipts) {
    const live = await client.getTransactionReceipt({hash:receipt.transactionHash});
    check(`receipt.${receipt.transactionHash}`,live.status,'success');
  }
  for (const [name,key] of [['CoralToken','CKEY'],['FreeDaoNFT','NFT'],['CoralIdo','IDO'],['CoralRewards','REWARDS'],['FreeDaoNFTInterest','INTEREST']]) {
    const creates=run.transactions.filter(t=>t.contractName===name && t.transactionType==='CREATE');
    if (creates.length!==1) throw new Error(`${name} 的部署记录必须恰好一条`);
    const tx=creates[0]; const record=creationReceipt(run,tx);
    const live=await client.getTransactionReceipt({hash:record.transactionHash});
    validateCreation(tx,await client.getTransaction({hash:record.transactionHash}),live);
    check(`deployment.${key}`,getAddress(tx.contractAddress),a[key]);
  }
}
for (const key of names) {
  check(`${key}.bytecode`, ((await client.getCode({ address: a[key], blockNumber: block.number })) || '0x') !== '0x', true);
}
for (const [getter, key] of [['usdt','USDT'], ['nemo','CKEY'], ['nft','NFT'], ['rewards','REWARDS'], ['nftInterest','INTEREST']]) check(`IDO.${getter}`, await read('IDO', getter), a[key]);
for (const key of names.filter(n => n !== 'USDT')) {
  check(`${key}.owner`, await read(key,'owner'), owner);
  check(`${key}.pendingOwner`, await read(key,'pendingOwner'), zeroAddress);
}
for (const key of ['NFT','CKEY']) check(`${key}.minter`, await read(key,'minter'), a.IDO);
for (const [key, fn, expected] of [['CKEY','name','Ckey'], ['CKEY','symbol','CKEY'], ['NFT','name','FreeDaoRWA'], ['NFT','symbol','FREEDAONFT']]) check(`${key}.${fn}.exact`, (await read(key,fn,'string')) === expected, true);
check('CKEY.interestMinter', await read('CKEY','interestMinter'), a.INTEREST);
for (const key of ['REWARDS','INTEREST']) check(`${key}.vault`, await read(key,'vault'), a.IDO);
check('INTEREST.nemo', await read('INTEREST','nemo'), a.CKEY);
const uints = { weekDuration:604800n, rewardsDelay:86400n, nftCap:10000n, directReferralBps:1000n, minIdo:10n**18n, tokensPerUsdt:100n*10n**18n, ambassadorMin:100n*10n**18n, partnerMin:1000n*10n**18n };
for (const [fn, expected] of Object.entries(uints)) check(`IDO.${fn}`, await read('IDO',fn,'uint256'), expected);
check('USDT.decimals', await read('USDT','decimals','uint8'), 18);
check('IDO.weekByBlock', await read('IDO','weekByBlock','bool'), false);
check('IDO.idoEnded', await read('IDO','idoEnded','bool'), false);
check('IDO.paused', await read('IDO','paused','bool'), false);
check('INTEREST.calendarWeeks', await read('INTEREST','calendarWeeks','bool'), true);
check('INTEREST.CALENDAR_WEEK', await read('INTEREST','CALENDAR_WEEK','uint256'), 604800n);
check('INTEREST.FIRST_SUNDAY_BEIJING', await read('INTEREST','FIRST_SUNDAY_BEIJING','uint256'), 230400n);
check('INTEREST.interestCap', await read('INTEREST','interestCap','uint256'), 50000000n*10n**18n);
check('INTEREST.accountCapBps', await read('INTEREST','accountCapBps','uint256'), 10000n);
check('INTEREST.detached', await read('INTEREST','detached','bool'), false);
check('CKEY.CAP', await read('CKEY','CAP','uint256'), 1000000000n*10n**18n);
check('CKEY.paused', await read('CKEY','paused','bool'), false);
for (const key of ['NFT','CKEY']) check(`${key}.transfersEnabled`, await read(key,'transfersEnabled','bool'), false);
check('NFT.imageURI', await read('NFT','imageURI','string'), need('NFT_IMAGE_URI'));
const tiers = await client.readContract({ address:a.INTEREST, abi:parseAbi(['function tiersOf(uint256) view returns ((uint256 minNfts,uint256 weeklyBps)[])']), functionName:'tiersOf', args:[0n], blockNumber:block.number });
check('INTEREST.initialTiers', JSON.stringify(tiers.map(t => [String(t.minNfts),String(t.weeklyBps)])), JSON.stringify([['2','100'],['10','200'],['20','250'],['60','300']]));
check('INTEREST.versionCount', await read('INTEREST','versionCount','uint256'), 1n);
check('IDO.saleOpen', await read('IDO','saleOpen','bool'), stage === 'ready');
check('IDO.importFrozen', await read('IDO','importFrozen','bool'), stage === 'ready');
check('INTEREST.saleOpened', await read('INTEREST','saleOpened','bool'), stage === 'ready');
if (stage === 'ready') {
  const publisher = address('EXPECTED_PUBLISHER');
  if (publisher === owner) throw new Error('Publisher 必须与 Owner 分离');
  if (BigInt(need('EXPECTED_MAX_ROOT_INCREASE_WEI')) <= 0n) throw new Error('主网发布增量上限必须显式大于零');
  check('REWARDS.publisher', await read('REWARDS','publisher'), publisher);
  for (const [fn, env] of [['maxRootIncrease','EXPECTED_MAX_ROOT_INCREASE_WEI'],['historicalTeamBudget','EXPECTED_HISTORICAL_TEAM_BUDGET_WEI']]) check(`REWARDS.${fn}`, await read('REWARDS',fn,'uint256'), BigInt(need(env)));
  check('IDO.totalImported', await read('IDO','totalImported','uint256'), BigInt(need('EXPECTED_TOTAL_IMPORTED_WEI')));
}
for (const [key, fn, type] of [['IDO','totalImported','uint256'],['IDO','totalContributed','uint256'],['IDO','reservedRewards','uint256'],['IDO','treasuryWithdrawable','uint256'],['REWARDS','committed','uint256'],['REWARDS','rewardCap','uint256'],['REWARDS','publisher','address']]) results.push({name:`snapshot.${key}.${fn}`, actual:printable(await read(key,fn,type))});
console.log(JSON.stringify({ ok:failures.length===0, readOnly:true, stage, chainId:56, blockNumber:String(block.number), blockHash:block.hash, addresses:a, results, failures, scope:'参数和关联核验；不代替源码验证、全量历史账户核对、资金充足性验收或安全审计' },null,2));
if (failures.length) process.exitCode = 1;
