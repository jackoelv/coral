import { parseAbi } from "viem";
import { buildPlan, planTx } from "./sign-plan.mjs";

export const DIRECT_BPS_TARGET = 500n;

export const IDO_ABI = parseAbi([
  "function owner() view returns (address)",
  "function directReferralBps() view returns (uint256)",
  "function setDirectReferralBps(uint256 bps)",
]);

function flag(argv, name) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const pos = argv.indexOf(`--${name}`);
  if (pos >= 0 && argv[pos + 1] && !argv[pos + 1].startsWith("--")) return argv[pos + 1];
  return "";
}

export function parseDirectArgs(argv) {
  const portRaw = flag(argv, "port");
  const port = portRaw ? Number(portRaw) : 8757;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 不对");
  return { apply: argv.includes("--apply"), port };
}

export function directPlan({ owner, ido, current }) {
  return buildPlan({
    chainId: 56,
    signer: owner,
    signerRole: "Owner",
    purpose: `把直推比例从 ${current} 改成 500（5%）。只影响这笔交易之后的新入金，已经计提的不变。`,
    meta: { kind: "setDirectReferralBps", previous: current.toString(), bps: DIRECT_BPS_TARGET.toString() },
    txs: [planTx({
      label: "setDirectReferralBps",
      contract: "CoralIdo",
      to: ido,
      signature: "function setDirectReferralBps(uint256 bps)",
      args: [DIRECT_BPS_TARGET],
    })],
  });
}
