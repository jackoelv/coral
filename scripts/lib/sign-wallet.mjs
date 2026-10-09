import { getAddress } from "viem";

/** Hex gas limit passed to the wallet. Bug log: keep estimate × 1.5, do not drop `gas`. */
export function gasCeiling(estimate) {
  if (typeof estimate !== "bigint" || estimate <= 0n) throw new Error("gas 估算无效");
  return `0x${((estimate * 3n) / 2n).toString(16)}`;
}

/**
 * Accounts the wallet approved for this chain, in the wallet's own order.
 * WalletConnect lists them as `eip155:<chainId>:0x...`.
 */
export function accountsOnChain(session, chainId) {
  const accounts = session?.namespaces?.eip155?.accounts || [];
  const prefix = `eip155:${chainId}:`.toLowerCase();
  return accounts
    .filter((item) => String(item).toLowerCase().startsWith(prefix))
    .map((item) => getAddress(String(item).slice(prefix.length)));
}

/**
 * The first approved account is the one that will sign. imToken, like the Binance
 * extension, can ignore `from` and use the active account. Refuse otherwise.
 */
export function assertActiveSigner(accounts, signer, chainId) {
  const expected = getAddress(signer);
  if (!accounts.length) {
    throw new Error(`imToken 没有授权链 ${chainId} 上的账户。请在手机里切换到链 ${chainId}，选中 ${expected} 后点重新连接。`);
  }
  const first = getAddress(accounts[0]);
  if (first !== expected) {
    throw new Error(`imToken 当前账户是 ${first}，不是 ${expected}。请在 imToken 里切换到这个地址，然后点重新连接。`);
  }
  return first;
}

/** eth_sendTransaction params. No private key, no viem writeContract. */
export function buildSendParams({ from, to, data, gas }) {
  return { from, to, data, value: "0x0", gas };
}

/** Reown project id. Empty means the phone path is off. A bad value is a config error. */
export function walletConnectProjectId(value) {
  const id = String(value || "").trim();
  if (!id) return null;
  if (!/^[0-9a-fA-F]{32}$/.test(id)) {
    throw new Error("WALLETCONNECT_PROJECT_ID 必须是 32 位十六进制。这是 cloud.reown.com 的项目编号，不是私钥。");
  }
  return id;
}
