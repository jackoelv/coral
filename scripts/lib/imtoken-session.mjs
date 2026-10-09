import { getAddress } from "viem";
import { accountsOnChain, assertActiveSigner } from "./sign-wallet.mjs";

/**
 * Phone session for imToken via WalletConnect. The private key stays on the phone.
 * This process only holds a pairing and sends eth_sendTransaction. Rules from the
 * chain bug log: no viem writeContract; the first account on this chain must be
 * the planned signer; the caller supplies gas.
 */
export async function openImtokenSession({ projectId, chainId, signer }) {
  const { SignClient } = await import("@walletconnect/sign-client");
  const { getSdkError } = await import("@walletconnect/utils");
  const qrcode = await import("qrcode");
  const QRCode = qrcode.default?.toDataURL ? qrcode.default : qrcode;
  const client = await SignClient.init({
    projectId,
    logger: "error",
    telemetryEnabled: false,
    storage: memoryStorage(),
    metadata: {
      name: "Nemo 本机签名",
      description: "在电脑上准备交易，在 imToken 里确认。私钥不会离开手机。",
      url: "https://www.freedao.life",
      icons: ["https://www.freedao.life/favicon.ico"],
    },
  });
  const session = new ImtokenSession({ client, chainId, signer, QRCode, getSdkError });
  client.on("session_delete", ({ topic }) => {
    if (topic !== session.approved?.topic) return;
    session.approved = null;
    session.qr = null;
    session.status = "error";
    session.error = "手机已断开连接。点重新连接，再用 imToken 扫新的二维码。";
  });
  await session.pair();
  return session;
}

class ImtokenSession {
  constructor({ client, chainId, signer, QRCode, getSdkError }) {
    this.client = client;
    this.chainId = chainId;
    this.signer = getAddress(signer);
    this.QRCode = QRCode;
    this.getSdkError = getSdkError;
    this.generation = 0;
    this.approved = null;
    this.qr = null;
    this.status = "starting";
    this.error = null;
  }

  snapshot() {
    const accounts = accountsOnChain(this.approved, this.chainId);
    const reconnect = this.status !== "starting";
    if (this.status === "connected") {
      try {
        const account = assertActiveSigner(accounts, this.signer, this.chainId);
        return { enabled: true, status: "connected", match: true, reconnect, account, message: `已连接 ${account}。核对地址后再签。`, qr: null };
      } catch (error) {
        return { enabled: true, status: "connected", match: false, reconnect, account: accounts[0] || null, message: error.message, qr: null };
      }
    }
    if (this.status === "waiting") {
      return {
        enabled: true,
        status: "waiting",
        match: false,
        reconnect,
        account: null,
        message: `用 imToken 扫描二维码。先在手机里选中 ${this.signer}，网络切到链 ${this.chainId}（BNB Smart Chain 是 56）。二维码大约 5 分钟内有效。`,
        qr: this.qr,
      };
    }
    if (this.status === "error") {
      return { enabled: true, status: "error", match: false, reconnect, account: null, message: this.error || "连接失败", qr: null };
    }
    return { enabled: true, status: "starting", match: false, reconnect: false, account: null, message: "正在生成二维码…", qr: null };
  }

  async pair() {
    const generation = ++this.generation;
    this.approved = null;
    this.qr = null;
    this.error = null;
    this.status = "starting";
    let uri;
    let approval;
    try {
      ({ uri, approval } = await this.client.connect({
        optionalNamespaces: {
          eip155: {
            methods: ["eth_sendTransaction"],
            chains: [`eip155:${this.chainId}`],
            events: ["chainChanged", "accountsChanged"],
          },
        },
      }));
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = "error";
      this.error = error?.message || "没有生成二维码";
      throw error;
    }
    if (generation !== this.generation) return;
    try {
      if (!uri) throw new Error("WalletConnect 没有返回二维码");
      this.qr = await this.QRCode.toDataURL(uri, { width: 320, margin: 2, errorCorrectionLevel: "M" });
      if (!String(this.qr).startsWith("data:image/png;base64,")) throw new Error("二维码生成失败");
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = "error";
      this.error = error?.message || "二维码生成失败";
      throw error;
    }
    this.status = "waiting";
    approval().then((approved) => {
      if (generation !== this.generation) return;
      this.approved = approved;
      this.qr = null;
      this.status = "connected";
      this.error = null;
    }).catch(() => {
      if (generation !== this.generation) return;
      this.approved = null;
      this.qr = null;
      this.status = "error";
      this.error = "二维码已失效，或手机拒绝了连接。点重新连接后再扫一次。";
    });
  }

  async reconnect() {
    const topic = this.approved?.topic;
    this.approved = null;
    this.generation += 1;
    if (topic) {
      await this.client.disconnect({ topic, reason: this.getSdkError("USER_DISCONNECTED") }).catch(() => {});
    }
    await this.pair();
  }

  async send(tx) {
    const from = assertActiveSigner(accountsOnChain(this.approved, this.chainId), this.signer, this.chainId);
    if (getAddress(tx.from) !== from) throw new Error("交易的 from 不是签名地址");
    const hash = await this.client.request({
      topic: this.approved.topic,
      chainId: `eip155:${this.chainId}`,
      request: { method: "eth_sendTransaction", params: [tx] },
    });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("imToken 没有返回交易哈希");
    return hash;
  }

  async close() {
    this.generation += 1;
    const topic = this.approved?.topic;
    this.approved = null;
    this.qr = null;
    if (!topic) return;
    await this.client.disconnect({ topic, reason: this.getSdkError("USER_DISCONNECTED") }).catch(() => {});
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    async getKeys() { return [...map.keys()]; },
    async getEntries() { return [...map.entries()]; },
    async getItem(key) { return map.has(key) ? map.get(key) : undefined; },
    async setItem(key, value) { map.set(key, value); },
    async removeItem(key) { map.delete(key); },
  };
}
