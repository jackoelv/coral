import { encodeFunctionData, formatUnits, getAddress, parseAbi, parseUnits, zeroAddress } from "viem";
import { buildPlan, planTx } from "./sign-plan.mjs";

export const TOKEN_ABI = parseAbi([
  "function owner() view returns (address)",
  "function CAP() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfersEnabled() view returns (bool)",
  "function transferAllowlist(address) view returns (bool)",
  "function mint(address to, uint256 amount)",
  "function setTransferAllowlist(address account, bool allowed)",
  "error NotAuthorized()",
  "error CapExceeded()",
  "error ZeroAddress()",
]);

export const VAULT_ABI = parseAbi([
  "function totalNemoAllocated() view returns (uint256)",
]);

const IMKEY_PATH = "m/44'/60'/0'/0/0";

export function wholeTokens(raw) {
  if (!/^[1-9]\d*$/.test(raw || "")) throw new Error("--amount 要写成正整数枚数，例如 1000");
  return parseUnits(raw, 18);
}

function flag(argv, name) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const pos = argv.indexOf(`--${name}`);
  if (pos >= 0 && argv[pos + 1] && !argv[pos + 1].startsWith("--")) return argv[pos + 1];
  return "";
}

function addressFlag(argv, name) {
  const raw = flag(argv, name);
  if (!raw) throw new Error(`缺少 --${name}`);
  try {
    const address = getAddress(raw);
    if (address === zeroAddress) throw new Error("零地址");
    return address;
  } catch (error) {
    if (error.message === "零地址") throw new Error(`--${name} 不能是零地址`);
    throw new Error(`--${name} 不是地址`);
  }
}

/** mint 和 allowlist 互不读取对方的参数。 */
export function parseCkeyArgs(argv) {
  const kind = argv.find((arg) => arg === "mint" || arg === "allowlist");
  if (!kind) throw new Error("命令是 mint 或 allowlist");
  const portRaw = flag(argv, "port");
  const port = portRaw ? Number(portRaw) : 8757;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 不对");
  const apply = argv.includes("--apply");
  if (kind === "mint") {
    return { kind, apply, port, to: addressFlag(argv, "to"), amount: wholeTokens(flag(argv, "amount")) };
  }
  return { kind, apply, port, account: addressFlag(argv, "account") };
}

export function mintCall(to, amount) {
  return {
    functionName: "mint",
    args: [
      { name: "to", type: "address", value: to },
      { name: "amount", type: "uint256", value: amount.toString() },
    ],
    data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [to, amount] }),
  };
}

export function allowlistCall(account) {
  return {
    functionName: "setTransferAllowlist",
    args: [
      { name: "account", type: "address", value: account },
      { name: "allowed", type: "bool", value: "true" },
    ],
    data: encodeFunctionData({
      abi: TOKEN_ABI,
      functionName: "setTransferAllowlist",
      args: [account, true],
    }),
  };
}

export function imkeyPath() {
  return IMKEY_PATH;
}

/** One Owner transaction for the imToken sign page. Calldata is encoded here. */
export function ckeySignPlan({ owner, token, kind, to, amount, account }) {
  if (kind === "mint") {
    return buildPlan({
      chainId: 56,
      signer: owner,
      signerRole: "Owner",
      purpose: `铸造 ${formatUnits(amount, 18)} 枚 CKEY 到 ${to}`,
      meta: { kind: "ckeyMint", to, amount: amount.toString() },
      txs: [planTx({
        label: "mint",
        contract: "CoralToken",
        to: token,
        signature: "function mint(address to, uint256 amount)",
        args: [to, amount],
      })],
    });
  }
  return buildPlan({
    chainId: 56,
    signer: owner,
    signerRole: "Owner",
    purpose: `把 ${account} 加入 CKEY 转账白名单`,
    meta: { kind: "ckeyAllowlist", account },
    txs: [planTx({
      label: "setTransferAllowlist",
      contract: "CoralToken",
      to: token,
      signature: "function setTransferAllowlist(address account, bool allowed)",
      args: [account, true],
    })],
  });
}
