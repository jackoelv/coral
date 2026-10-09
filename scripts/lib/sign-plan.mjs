import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi } from "viem";

export const CHAIN_HEX = { 56: "0x38", 97: "0x61" };

/** One transaction for the browser signer. Calldata is encoded here, never typed by hand. */
export function planTx({ label, contract, to, signature, args = [] }) {
  const abi = parseAbi([signature]);
  const functionName = abi[0].name;
  return {
    label,
    contract,
    to: getAddress(to),
    abi: signature,
    functionName,
    data: encodeFunctionData({ abi, functionName, args }),
    status: "pending",
    hash: null,
  };
}

export function buildPlan({ chainId, signer, signerRole, purpose, txs, meta = {} }) {
  if (!CHAIN_HEX[chainId]) throw new Error(`不支持的 chainId ${chainId}`);
  if (txs.length === 0) throw new Error("交易计划是空的");
  return {
    version: 1,
    chainId,
    signer: getAddress(signer),
    signerRole,
    purpose,
    createdAt: new Date().toISOString(),
    meta,
    txs,
  };
}

const printable = (value) => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(printable);
  return value;
};

/** Decodes each tx from its own calldata and checks the target is one of `allowed`. */
export function checkPlan(plan, allowed) {
  if (plan.version !== 1 || !CHAIN_HEX[plan.chainId]) throw new Error("计划文件格式不对");
  const allow = new Set([...allowed].map((a) => getAddress(a)));
  getAddress(plan.signer);
  return plan.txs.map((tx, index) => {
    const to = getAddress(tx.to);
    if (!allow.has(to)) throw new Error(`第 ${index + 1} 笔的目标 ${to} 不是本次部署的合约`);
    const abi = parseAbi([tx.abi]);
    const decoded = decodeFunctionData({ abi, data: tx.data });
    if (decoded.functionName !== tx.functionName) throw new Error(`第 ${index + 1} 笔的 calldata 和函数名不一致`);
    const inputs = abi[0].inputs;
    return {
      index,
      label: tx.label,
      contract: tx.contract,
      to,
      functionName: tx.functionName,
      args: inputs.map((input, i) => ({ name: input.name || `arg${i}`, type: input.type, value: printable(decoded.args?.[i]) })),
      status: tx.status,
      hash: tx.hash,
    };
  });
}

export function nextPending(plan) {
  return plan.txs.findIndex((tx) => tx.status !== "success");
}

export function readPlan(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writePlan(path, plan) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
