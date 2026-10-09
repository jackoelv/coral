#!/usr/bin/env node
/**
 * Checks NFT_IMAGE_URI returns HTTP 200 and matches the chain. --apply calls setImageURI with the deployer.
 * Run before handover; afterwards the Owner must sign setImageURI.
 *
 *   npm run nft-image:mainnet
 *   npm run nft-image:mainnet -- --apply
 */
import { getAddress, parseAbi } from "viem";
import { contracts, deployerAccount, mainnetClient, need, readMainnetEnv, sendAsDeployer } from "./lib/mainnet.mjs";

const ABI = parseAbi(["function owner() view returns (address)", "function imageURI() view returns (string)", "function setImageURI(string)"]);
const apply = process.argv.includes("--apply");
const env = readMainnetEnv();
const client = await mainnetClient(env);
const nft = contracts(env).NFT;
const uri = need(env, "NFT_IMAGE_URI");
if (!uri.startsWith("https://")) throw new Error("NFT_IMAGE_URI 必须是 https");
const host = new URL(uri).host;
if (/(^|\.)preview\.freedao\.life$/.test(host)) throw new Error("主网 NFT 图片不要用预览域名");
if (host === "test.freedao.life") console.warn("NFT 图片暂时用 test.freedao.life。正式站上线后改成 www.freedao.life 的地址，再跑一次 nft-image:mainnet。");
let remote;
try {
  const response = await fetch(uri, { method: "HEAD", redirect: "follow" });
  remote = { status: response.status, type: response.headers.get("content-type") || "" };
} catch (error) {
  remote = { status: 0, type: error.message };
}
const current = await client.readContract({ address: nft, abi: ABI, functionName: "imageURI" });
console.log(JSON.stringify({ nft, onChain: current, target: uri, http: remote, apply }, null, 2));
if (remote.status !== 200 || !remote.type.startsWith("image/")) throw new Error(`图片现在 HTTP ${remote.status} ${remote.type}。先确认这个地址能公开打开`);
if (current === uri) {
  console.log("链上已是这个地址，图片可公开访问。");
  process.exit(0);
}
if (!apply) {
  console.log("链上地址不同。确认后：npm run nft-image:mainnet -- --apply");
  process.exit(0);
}
const account = deployerAccount(env);
if (getAddress(await client.readContract({ address: nft, abi: ABI, functionName: "owner" })) !== account.address) {
  throw new Error("NFT Owner 已不是部署账户，改由 Owner 在签名页签 setImageURI");
}
await sendAsDeployer({ env, client, account, to: nft, abi: ABI, functionName: "setImageURI", args: [uri] });
if ((await client.readContract({ address: nft, abi: ABI, functionName: "imageURI" })) !== uri) throw new Error("imageURI 没有更新");
console.log("imageURI 已更新。");
