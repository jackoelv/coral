import { encodeAbiParameters, keccak256, concat, toHex } from "viem";

export function hashPair(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** OpenZeppelin leaf: keccak256(bytes.concat(keccak256(abi.encode(account, cumulative)))). */
export function leafHash(account, cumulative) {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
      ],
      [account, BigInt(cumulative)],
    ),
  );
  return keccak256(inner);
}

export function buildMerkle(entries) {
  const leaves = entries.map((e) => leafHash(e.account, e.cumulative));
  if (leaves.length === 0) {
    return { root: keccak256(toHex(new Uint8Array())), proofs: new Map(), leaves };
  }
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 === prev.length) next.push(prev[i]);
      else next.push(hashPair(prev[i], prev[i + 1]));
    }
    layers.push(next);
  }
  const proofs = new Map();
  for (let i = 0; i < leaves.length; i++) {
    const proof = [];
    let idx = i;
    for (let layer = 0; layer < layers.length - 1; layer++) {
      const nodes = layers[layer];
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sibling < nodes.length) proof.push(nodes[sibling]);
      idx = Math.floor(idx / 2);
    }
    proofs.set(leaves[i], proof);
  }
  return { root: layers[layers.length - 1][0], proofs, leaves };
}
