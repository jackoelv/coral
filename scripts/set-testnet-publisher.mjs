#!/usr/bin/env node
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, encodeFunctionData } from 'viem';
import { bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readTestnetEnv, saveTestnetEnv } from './lib/testnet-env.mjs';
const env = readTestnetEnv();
const owner = privateKeyToAccount(env.TEST_PRIVATE_KEY);
const publisher = privateKeyToAccount(env.PUBLISHER_PRIVATE_KEY).address;
if (publisher === owner.address) throw new Error('publisher必须与Owner不同');
if (getAddress(env.BSC_TESTNET_REWARDS)!==getAddress(env.REWARDS_ADDRESS)) throw new Error('两套奖励合约地址不一致');
const publicClient = createPublicClient({chain:bscTestnet,transport:http(env.BSC_TESTNET_RPC)});
if (await publicClient.getChainId()!==97) throw new Error('RPC不是97');
const address = getAddress(env.BSC_TESTNET_REWARDS);
const abi = parseAbi(['function owner() view returns(address)','function publisher() view returns(address)','function setPublisher(address)']);
if (getAddress(await publicClient.readContract({address,abi,functionName:'owner'}))!==owner.address) throw new Error('TEST_PRIVATE_KEY不是奖励合约Owner');
const current = getAddress(await publicClient.readContract({address,abi,functionName:'publisher'}));
console.log({rewards:address,current,publisher,apply:process.argv.includes('--apply')});
if (process.argv.includes('--apply')) {
  if (current!==publisher) {
    const {request} = await publicClient.simulateContract({account:owner,address,abi,functionName:'setPublisher',args:[publisher]});
    const wallet = createWalletClient({account:owner,chain:bscTestnet,transport:http(env.BSC_TESTNET_RPC)});
    const hash = await wallet.sendTransaction({to:address, data:encodeFunctionData({abi,functionName:'setPublisher',args:[publisher]}), gas:request.gas});
    if ((await publicClient.waitForTransactionReceipt({hash})).status!=='success') throw new Error(`publisher设置回滚：${hash}`);
    console.log({hash});
  }
  if (getAddress(await publicClient.readContract({address,abi,functionName:'publisher'}))!==publisher) throw new Error('publisher链上核对失败');
  saveTestnetEnv({PUBLISHER_ADDRESS:publisher});
  console.log('publisher链上与.env一致');
}
