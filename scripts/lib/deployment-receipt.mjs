import {getAddress, getContractAddress} from 'viem';
export function creationReceipt(run, tx) {
  const address = getAddress(tx.contractAddress);
  const matches = run.receipts.filter(r=>r.contractAddress && getAddress(r.contractAddress)===address);
  if (matches.length!==1 || BigInt(matches[0].status)!==1n) throw new Error(`${tx.contractName}缺少唯一成功创建回执`);
  return matches[0];
}
export function validateCreation(tx, liveTx, receipt) {
  const expected = getAddress(tx.contractAddress);
  if (receipt.status!=='success' || !receipt.contractAddress || getAddress(receipt.contractAddress)!==expected ||
      liveTx.to!==null || getAddress(liveTx.from)!==getAddress(tx.transaction.from) ||
      BigInt(liveTx.nonce)!==BigInt(tx.transaction.nonce) ||
      liveTx.input.toLowerCase()!==(tx.transaction.input || tx.transaction.data).toLowerCase() ||
      getAddress(getContractAddress({from:liveTx.from,nonce:BigInt(liveTx.nonce)}))!==expected) {
    throw new Error(`${tx.contractName}链上创建交易不一致`);
  }
}
