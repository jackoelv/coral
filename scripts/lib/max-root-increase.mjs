import { formatUnits, parseAbi } from "viem";
import { buildPlan, planTx } from "./sign-plan.mjs";

export const REWARDS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function maxRootIncrease() view returns (uint256)",
  "function setMaxRootIncrease(uint256 amount)",
]);

function flag(argv, name) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const pos = argv.indexOf(`--${name}`);
  if (pos >= 0 && argv[pos + 1] && !argv[pos + 1].startsWith("--")) return argv[pos + 1];
  return "";
}

/** Raw e18 integer. 318 USDT is 318000000000000000000, not 318. */
export function parseIncreaseWei(raw) {
  const text = (raw || "").trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error("--amount 要写成大于 0 的 e18 整数，例如 318 USDT 写成 318000000000000000000");
  }
  return BigInt(text);
}

export function parseIncreaseArgs(argv) {
  const portRaw = flag(argv, "port");
  const port = portRaw ? Number(portRaw) : 8756;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 不对");
  return { apply: argv.includes("--apply"), port, amount: parseIncreaseWei(flag(argv, "amount")) };
}

export function increasePlan({ owner, rewards, current, amount }) {
  return buildPlan({
    chainId: 56,
    signer: owner,
    signerRole: "Owner",
    purpose: `把单次发布增量上限从 ${formatUnits(current, 18)} 改成 ${formatUnits(amount, 18)} USDT（${amount} e18）`,
    meta: { kind: "setMaxRootIncrease", previous: current.toString(), amount: amount.toString() },
    txs: [planTx({
      label: "setMaxRootIncrease",
      contract: "CoralRewards",
      to: rewards,
      signature: "function setMaxRootIncrease(uint256 amount)",
      args: [amount],
    })],
  });
}
