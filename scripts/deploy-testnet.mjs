#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readTestnetEnv, saveTestnetEnv, scopedEnv } from './lib/testnet-env.mjs';

import { creationReceipt, validateCreation } from './lib/deployment-receipt.mjs';

const config = readTestnetEnv();
const apply = process.argv.includes('--apply');
const syncOnly = process.argv.includes('--sync');
if (apply && syncOnly) throw new Error('--apply 与 --sync 不能同时使用');
if (!config.BSC_TESTNET_RPC || !config.TEST_PRIVATE_KEY) throw new Error('请先在.env配置BSC_TESTNET_RPC和TEST_PRIVATE_KEY');
const owner = privateKeyToAccount(config.TEST_PRIVATE_KEY).address;
const client = createPublicClient({transport: http(config.BSC_TESTNET_RPC)});
if (await client.getChainId() !== 97) throw new Error('拒绝操作：RPC不是chainId 97');
if (config.OWNER && getAddress(config.OWNER) !== owner) throw new Error('OWNER与部署账户不一致；本流程要求部署账户成为Owner');
if (config.PUBLISHER_PRIVATE_KEY && privateKeyToAccount(config.PUBLISHER_PRIVATE_KEY).address === owner) throw new Error('publisher必须与部署账户不同');
console.log(JSON.stringify({chainId:97, owner, mode: syncOnly?'sync':apply?'deploy':'preview', generatePublisher:!config.PUBLISHER_PRIVATE_KEY}, null, 2));
if (!apply && !syncOnly) { console.log('预览完成。部署并自动更新.env：npm run deploy:testnet -- --apply'); process.exit(0); }

const artifact = 'broadcast/Deploy.s.sol/97/run-latest.json';
if (apply) {
  const start = Date.now();
  const result = spawnSync(`${homedir()}/.foundry/bin/forge`, ['script','script/Deploy.s.sol:Deploy','--rpc-url',config.BSC_TESTNET_RPC,'--broadcast','-vv'], {
    env: {...scopedEnv(config), NETWORK:'bscTestnet', OWNER:owner, NFT_IMAGE_URI:'https://test.freedao.life/media/nomad/rwa-nft-pass.webp'}, encoding:'utf8', maxBuffer:20*1024*1024,
  });
  // Never print output containing any configured private key.
  let output = (result.stdout || '') + (result.stderr || '');
  for (const [key,value] of Object.entries(config)) if (key.includes('PRIVATE_KEY') && value) output = output.split(value).join('[REDACTED]');
  console.log(output);
  if (result.error || result.status !== 0) throw new Error('部署未全部成功；.env未更新。不要重复部署，先检查broadcast回执并恢复失败交易');
  if (statSync(artifact).mtimeMs < start) throw new Error('未发现本次部署产物，拒绝使用旧地址');
}
const run = JSON.parse(readFileSync(artifact,'utf8'));
if (Number(run.chain) !== 97) throw new Error('部署记录不是97');
if (!run.receipts?.length || run.receipts.some(r=>BigInt(r.status)!==1n)) throw new Error('部署中有缺失或失败回执，拒绝同步');
const names = {CoralToken:'CKEY',CoralNFT:'NFT',CoralIdo:'IDO',CoralRewards:'REWARDS',CoralNftInterest:'INTEREST'};
const updates = {};
const blocks = [];
const usdtCreates = run.transactions.filter(t=>t.contractName==='MockUSDT' && t.transactionType==='CREATE');
if (usdtCreates.length !== 0) throw new Error('本次部署不应新铸MockUSDT');
if (!config.BSC_TESTNET_USDT) throw new Error('测试网必须沿用.env里的BSC_TESTNET_USDT');
const usdt = getAddress(config.BSC_TESTNET_USDT);
if (!(await client.getCode({address:usdt}))) throw new Error('现有MockUSDT没有字节码');
updates.BSC_TESTNET_USDT = usdt;
for (const [name,key] of Object.entries(names)) {
  const txs = run.transactions.filter(t=>t.contractName===name && t.transactionType==='CREATE');
  if (txs.length !== 1) throw new Error(`${name}部署记录必须恰好一条`);
  const tx = txs[0];
  if (getAddress(tx.transaction.from) !== owner) throw new Error('部署记录的发送账户与TEST_PRIVATE_KEY不一致');
  const receipt = creationReceipt(run, tx);
  const address = getAddress(tx.contractAddress);
  const live = await client.getTransactionReceipt({hash:receipt.transactionHash});
  const liveTx = await client.getTransaction({hash:receipt.transactionHash});
  validateCreation(tx, liveTx, live);
  if (!(await client.getCode({address}))) throw new Error(`${name}没有字节码`);
  updates[`BSC_TESTNET_${key}`] = address;
  blocks.push(live.blockNumber);
}
const read = (key,name,type='address') => client.readContract({address:updates[`BSC_TESTNET_${key}`],abi:parseAbi([`function ${name}() view returns (${type})`]),functionName:name});
for (const [getter,key] of [['usdt','USDT'],['nemo','CKEY'],['nft','NFT'],['rewards','REWARDS'],['nftInterest','INTEREST']]) {
  if (getAddress(await read('IDO',getter))!==updates[`BSC_TESTNET_${key}`]) throw new Error(`金库${getter}关联错误`);
}
for (const key of ['CKEY','NFT','IDO','REWARDS','INTEREST']) if (getAddress(await read(key,'owner'))!==owner) throw new Error(`${key}Owner不一致`);
const rewardsDelay = await client.readContract({address:updates.BSC_TESTNET_IDO,abi:parseAbi(['function rewardsDelay() view returns (uint256)']),functionName:'rewardsDelay'});
if (rewardsDelay !== 600n) throw new Error(`测试网 rewardsDelay 应是 600 秒，实际 ${rewardsDelay}。确认源码已改成 10 minutes 后重新编译部署`);
const block = blocks.reduce((a,b)=>a<b?a:b).toString();
Object.assign(updates,{INDEX_START_BLOCK:block,START_BLOCK:block,IDO_ADDRESS:updates.BSC_TESTNET_IDO,REWARDS_ADDRESS:updates.BSC_TESTNET_REWARDS,RPC_URL:config.BSC_TESTNET_RPC,CHAIN_ID:'97',NETWORK:'bscTestnet',NFT_IMAGE_URI:'https://test.freedao.life/media/nomad/rwa-nft-pass.webp'});
if (!config.PUBLISHER_PRIVATE_KEY) updates.PUBLISHER_PRIVATE_KEY = generatePrivateKey();
updates.PUBLISHER_ADDRESS = privateKeyToAccount(config.PUBLISHER_PRIVATE_KEY || updates.PUBLISHER_PRIVATE_KEY).address;
saveTestnetEnv(updates);
console.log(JSON.stringify({...updates, PUBLISHER_PRIVATE_KEY: updates.PUBLISHER_PRIVATE_KEY?'[已安全写入，不显示]':undefined},null,2).replace(config.BSC_TESTNET_RPC,'[BSC_TESTNET_RPC]'));
console.log('沿用现有MockUSDT。五个新合约地址、最早部署区块及索引配置已同步。下一步按部署说明预览/重置测试库、导入，再设置publisher。');
