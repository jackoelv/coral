import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

export const WALLETS_FILE = process.env.WALLETS_FILE || "/Users/jack/Documents/Sensitive/nemo-bsc-testnet-wallets.json";
export const SIGNER_INDEXES = [17, 18, 19, 20];
export const DEFAULT_SIGNERS = [17, 18, 19];
export const TEMP_SIGNER_INDEX = 16;

export const MULTISIG_ABI = parseAbi([
  "function signers(uint256) view returns (address)",
  "function nonce() view returns (uint256)",
  "function execHash(address target, bytes data) view returns (bytes32)",
  "function replaceHash(address oldSigner, address next) view returns (bytes32)",
  "function exec(address target, bytes data, bytes[] signatures)",
  "function replaceSigner(address oldSigner, address next, bytes[] signatures)",
  "error NotEnoughSignatures()",
  "error BadSignature()",
  "error BadSigners()",
]);

export function loadWalletRows(file = WALLETS_FILE) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const wallets = Array.isArray(parsed) ? parsed : parsed.wallets;
  if (!Array.isArray(wallets)) throw new Error("钱包文件格式不对");
  return wallets;
}

export function rowByIndex(rows, index) {
  const row = rows.find((item) => item.index === index);
  if (!row?.address) throw new Error(`钱包文件缺少 index ${index}`);
  return row;
}

export function addressByIndex(rows, index) {
  return getAddress(rowByIndex(rows, index).address);
}

export function accountByIndex(rows, index) {
  const row = rowByIndex(rows, index);
  if (!row.privateKey) throw new Error(`钱包文件 index ${index} 没有私钥`);
  const account = privateKeyToAccount(row.privateKey);
  if (getAddress(account.address) !== getAddress(row.address)) {
    throw new Error(`index ${index} 的私钥和地址不一致`);
  }
  return account;
}

export function redact(text, rows) {
  let out = String(text);
  for (const row of rows) {
    if (row.privateKey) out = out.split(row.privateKey).join("[REDACTED]");
  }
  return out;
}

export function signerIndexes(argv, fallback = DEFAULT_SIGNERS) {
  return parseSignerSelection(argv, [], fallback);
}

/// 恰好 3 个签名人。可以写钱包 index，也可以写 0x 地址，两种可以混用。
export function parseSignerSelection(argv, rows = [], fallback = DEFAULT_SIGNERS) {
  const eq = argv.find((arg) => arg.startsWith("--signers="));
  const pos = argv.indexOf("--signers");
  const raw = eq ? eq.slice("--signers=".length) : pos >= 0 ? argv[pos + 1] : "";
  const tokens = raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : fallback.map(String);
  if (tokens.length !== 3) {
    throw new Error("需要恰好 3 个签名人，例如 --signers 17,19,20 或三个 0x 地址");
  }
  const indexes = tokens.map((token) => {
    if (/^0x[0-9a-fA-F]{40}$/.test(token)) {
      const address = getAddress(token);
      const row = rows.find((item) => item?.address && getAddress(item.address) === address);
      if (!row) throw new Error(`钱包文件里没有签名地址 ${address}`);
      return row.index;
    }
    const index = Number(token);
    if (!Number.isInteger(index)) throw new Error(`无法识别签名人：${token}`);
    return index;
  });
  if (indexes.some((index) => !Number.isInteger(index)) || new Set(indexes).size !== 3) {
    throw new Error("三个签名人必须是各不相同的钱包 index");
  }
  return indexes;
}

export function flagValue(argv, name) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const pos = argv.indexOf(`--${name}`);
  if (pos >= 0 && argv[pos + 1] && !argv[pos + 1].startsWith("--")) return argv[pos + 1];
  return "";
}

/// index 或 0x 地址。allowlist 目标可以不在钱包文件里。
export function resolveAddress(rows, token, label) {
  if (!token) throw new Error(`缺少 ${label}`);
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) return getAddress(token);
  const index = Number(token);
  if (!Number.isInteger(index)) throw new Error(`${label} 要写成钱包 index 或 0x 地址`);
  return addressByIndex(rows, index);
}

export function testnetClients(env) {
  if (!env.BSC_TESTNET_RPC || !env.TEST_PRIVATE_KEY) throw new Error("缺少 BSC_TESTNET_RPC 或 TEST_PRIVATE_KEY");
  const account = privateKeyToAccount(env.TEST_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: bscTestnet, transport: http(env.BSC_TESTNET_RPC) });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport: http(env.BSC_TESTNET_RPC) });
  return { account, publicClient, walletClient };
}

export async function assertChain(publicClient) {
  if ((await publicClient.getChainId()) !== 97) throw new Error("RPC 不是测试网 97");
}

async function send(publicClient, walletClient, to, data) {
  const gas = await publicClient.estimateGas({ account: walletClient.account, to, data });
  const hash = await walletClient.sendTransaction({ to, data, gas: (gas * 3n) / 2n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`交易回滚：${hash}`);
  return receipt;
}

export async function execMultisig({ publicClient, walletClient, multisig, signers, target, data, apply, rows }) {
  const hash = await publicClient.readContract({
    address: multisig,
    abi: MULTISIG_ABI,
    functionName: "execHash",
    args: [target, data],
  });
  const nonce = await publicClient.readContract({ address: multisig, abi: MULTISIG_ABI, functionName: "nonce" });
  console.log(JSON.stringify({
    multisig,
    target,
    nonce: nonce.toString(),
    signers: signers.map((account) => account.address),
    apply,
  }));
  if (!apply) return null;
  const signatures = [];
  for (const account of signers) signatures.push(await account.signMessage({ message: { raw: hash } }));
  const call = encodeFunctionData({
    abi: MULTISIG_ABI,
    functionName: "exec",
    args: [target, data, signatures],
  });
  try {
    const receipt = await send(publicClient, walletClient, multisig, call);
    console.log(receipt.transactionHash);
    return receipt;
  } catch (error) {
    throw new Error(redact(error?.message || error, rows));
  }
}

export async function replaceMultisigSigner({ publicClient, walletClient, multisig, signers, oldSigner, next, apply, rows }) {
  const hash = await publicClient.readContract({
    address: multisig,
    abi: MULTISIG_ABI,
    functionName: "replaceHash",
    args: [oldSigner, next],
  });
  console.log(JSON.stringify({ multisig, oldSigner, next, signers: signers.map((account) => account.address), apply }));
  if (!apply) return null;
  const signatures = [];
  for (const account of signers) signatures.push(await account.signMessage({ message: { raw: hash } }));
  const data = encodeFunctionData({
    abi: MULTISIG_ABI,
    functionName: "replaceSigner",
    args: [oldSigner, next, signatures],
  });
  try {
    const receipt = await send(publicClient, walletClient, multisig, data);
    console.log(receipt.transactionHash);
    return receipt;
  } catch (error) {
    throw new Error(redact(error?.message || error, rows));
  }
}

export async function signerList(publicClient, multisig) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(getAddress(await publicClient.readContract({
      address: multisig,
      abi: MULTISIG_ABI,
      functionName: "signers",
      args: [BigInt(i)],
    })));
  }
  return out;
}
