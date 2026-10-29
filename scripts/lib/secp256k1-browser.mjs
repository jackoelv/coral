/**
 * Browser stand-in for the native `secp256k1` package.
 * imKey's Eth app only calls signatureNormalize and ecdsaRecover.
 * The private key never comes here; this only checks the signature the device returned.
 */
import { ethers } from "ethers";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;

function read32(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 32; i++) value = (value << 8n) + BigInt(bytes[offset + i]);
  return value;
}

function write32(bytes, offset, value) {
  for (let i = 31; i >= 0; i--) {
    bytes[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

export function signatureNormalize(sig) {
  if (!sig || sig.length !== 64) throw new Error("signature length");
  const r = read32(sig, 0);
  const s = read32(sig, 32);
  if (r >= N || s >= N || r === 0n || s === 0n) throw new Error("signature parse");
  if (s > HALF_N) write32(sig, 32, N - s);
  return sig;
}

export function ecdsaRecover(sig, recid, msg32, compressed = true) {
  if (compressed) throw new Error("imKey 恢复公钥只用非压缩格式");
  if (!sig || sig.length !== 64 || !msg32 || msg32.length !== 32) throw new Error("recover input");
  if (!Number.isInteger(recid) || recid < 0 || recid > 3) throw new Error("recovery id");
  const signature = ethers.utils.joinSignature({
    r: `0x${Buffer.from(sig.subarray(0, 32)).toString("hex")}`,
    s: `0x${Buffer.from(sig.subarray(32, 64)).toString("hex")}`,
    recoveryParam: recid,
  });
  const digest = `0x${Buffer.from(msg32).toString("hex")}`;
  const pub = ethers.utils.recoverPublicKey(digest, signature);
  return Buffer.from(pub.slice(2), "hex");
}

export default { signatureNormalize, ecdsaRecover };
