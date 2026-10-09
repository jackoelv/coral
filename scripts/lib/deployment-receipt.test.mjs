import test from 'node:test';
import assert from 'node:assert/strict';
import {getContractAddress} from 'viem';
import {creationReceipt,validateCreation} from './deployment-receipt.mjs';
const from='0x8149a60BC2863DC23B32A75EE89409E20808906a';
const address=getContractAddress({from,nonce:105n});
const tx={contractName:'CoralToken',hash:'wrong',contractAddress:address,transaction:{from,nonce:'0x69',input:'0x1234'}};
const live={from,nonce:105,to:null,input:'0x1234'};
const receipt={contractAddress:address,status:'success'};
test('misaligned artifact hash resolves by creation address',()=>{
 const r=creationReceipt({receipts:[{transactionHash:'wrong',contractAddress:null,status:'0x1'},{transactionHash:'actual',contractAddress:address,status:'0x1'}]},tx);
 assert.equal(r.transactionHash,'actual');validateCreation(tx,live,receipt);
});
test('wrong nonce, input, sender or reverted receipt is rejected',()=>{
 for(const patch of [{nonce:106},{input:'0xabcd'},{from:'0x0000000000000000000000000000000000000001'},{to:from}])assert.throws(()=>validateCreation(tx,{...live,...patch},receipt));
 assert.throws(()=>validateCreation(tx,live,{...receipt,status:'reverted'}));
});
