#!/usr/bin/env node
// Destructive only to an explicitly selected, fresh localhost Anvil chain 31337.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, stringToHex, zeroHash, getAddress } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { leafHash } from './lib/merkle.mjs';
const rpc = process.env.LOCAL_REHEARSAL_RPC || 'http://127.0.0.1:18545';
const url = new URL(rpc);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Only a localhost rehearsal RPC is allowed');
const client = createPublicClient({transport:http(rpc)});
if (await client.getChainId() !== 31337) throw new Error('Only chain 31337 is allowed');
const run = JSON.parse(readFileSync('broadcast/Deploy.s.sol/31337/run-latest.json','utf8'));
const names=['MockUSDT','CoralToken','FreeDaoNFT','CoralIdo','CoralRewards','FreeDaoNFTInterest'];
const contracts=Object.fromEntries(names.map(name=>{
 const tx=run.transactions.find(t=>t.contractName===name && t.transactionType==='CREATE');
 return [name,{address:getAddress(tx.contractAddress),abi:JSON.parse(readFileSync(`out/${name}.sol/${name}.json`,'utf8')).abi}];
}));
const chain={id:31337,name:'Anvil isolated rehearsal',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}};
const mnemonic='test test test test test test test test test test test junk';
const users=[0,1].map(addressIndex=>mnemonicToAccount(mnemonic,{addressIndex}));
const wallets=users.map(account=>createWalletClient({account,chain,transport:http(rpc)}));
const receipts=[];
const read=(name,functionName,args=[])=>client.readContract({...contracts[name],functionName,args});
async function send(name,functionName,args=[],who=0) {
 const call={...contracts[name],functionName,args,account:users[who]};
 const gas=await client.estimateContractGas(call);
 const hash=await wallets[who].writeContract({...call,gas:gas*3n/2n});
 const receipt=await client.waitForTransactionReceipt({hash});
 assert.equal(receipt.status,'success'); receipts.push({name,functionName,hash,gasUsed:String(receipt.gasUsed)}); return receipt;
}
const U=10n**18n;
assert.equal(await read('CoralIdo','saleOpen'),false,'requires a fresh deployment');
await send('CoralIdo','freezeImport'); await send('CoralIdo','openSale');
await send('MockUSDT','approve',[contracts.CoralIdo.address,5000n*U]);
await send('CoralIdo','registerAndContribute',[stringToHex('ROOT0001',{size:32}),zeroHash,5000n*U]);
await send('MockUSDT','approve',[contracts.CoralIdo.address,1000n*U],1);
await send('CoralIdo','registerAndContribute',[stringToHex('BUYER001',{size:32}),stringToHex('ROOT0001',{size:32}),1000n*U],1);
assert.equal(await read('CoralIdo','totalContributed'),6000n*U);
assert.equal(await read('FreeDaoNFT','balanceOf',[users[1].address]),2n);
assert.equal(await read('CoralToken','balanceOf',[users[1].address]),100000n*U);
assert.equal(await read('CoralIdo','pendingOf',[users[0].address]),100n*U);
await assert.rejects(client.simulateContract({...contracts.CoralIdo,functionName:'contribute',args:[0n],account:users[1]}));
await send('CoralIdo','claim');
assert.equal(await read('CoralIdo','pendingOf',[users[0].address]),0n);
await client.request({method:'anvil_mine',params:['0x3c']});
assert((await read('FreeDaoNFTInterest','pending',[users[1].address]))>0n);
await send('FreeDaoNFTInterest','claim',[],1);
const team=50n*U; // 5% of buyer deposit: root qualifies at 5000 before deposit, classic tiers.
await send('CoralRewards','publishRoot',[leafHash(users[0].address,team),zeroHash,team,'']);
await send('CoralRewards','claim',[team,[]]);
assert.equal(await read('CoralRewards','claimed',[users[0].address]),team);
await assert.rejects(client.simulateContract({...contracts.CoralRewards,functionName:'claim',args:[team,[]],account:users[0]}));
console.log(JSON.stringify({ok:true,chainId:31337,checks:['deployment','approve','registerAndContribute','directClaim','NFTBalance','tokenBalance','zeroDepositRevert','interestClaim','MerkleClaim','duplicateClaimRevert'],addresses:Object.fromEntries(names.map(n=>[n,contracts[n].address])),receipts},null,2));
