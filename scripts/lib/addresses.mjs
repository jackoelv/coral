import { keccak256, toBytes } from "viem";

const SIMULATED = new Set(["local", "bscTestnet"]);

/** Deterministic address for a user id. Tree shape and volumes stay on the record. */
export function simulatedAddress(network, id) {
  const hash = keccak256(toBytes(`nemo-sim:${network}:${id}`));
  return `0x${hash.slice(-40)}`;
}

/**
 * local / bscTestnet replace wallets with simulated addresses.
 * bscMainnet keeps the exported wallets.
 */
export function remapForNetwork(records, network) {
  if (network === "bscMainnet") {
    return {
      records: records.map((r) => ({ ...r, sourceWallet: r.wallet })),
      map: records.map((r) => ({
        id: r.id,
        sourceWallet: r.wallet,
        wallet: r.wallet,
        simulated: false,
      })),
    };
  }
  if (!SIMULATED.has(network)) {
    throw new Error(`network must be local, bscTestnet, or bscMainnet (got ${network})`);
  }

  const bySource = new Map();
  const map = [];
  for (const r of records) {
    if (r.id === undefined || r.id === null || r.id === "") {
      throw new Error("remap requires record id");
    }
    const wallet = simulatedAddress(network, r.id);
    if (bySource.has(r.wallet)) {
      throw new Error(`duplicate source wallet ${r.wallet}`);
    }
    if ([...bySource.values()].includes(wallet)) {
      throw new Error(`simulated address collision ${wallet}`);
    }
    bySource.set(r.wallet, wallet);
    map.push({
      id: r.id,
      sourceWallet: r.wallet,
      wallet,
      inviteCode: r.inviteCode,
      simulated: true,
    });
  }

  const remapped = records.map((r) => {
    const wallet = bySource.get(r.wallet);
    const referrer = r.referrer ? bySource.get(r.referrer) : null;
    if (r.referrer && !referrer) {
      throw new Error(`missing simulated referrer for ${r.id}`);
    }
    return { ...r, sourceWallet: r.wallet, wallet, referrer };
  });
  return { records: remapped, map };
}
