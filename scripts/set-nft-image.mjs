#!/usr/bin/env node
/**
 * 把测试网 CoralNFT 的共享图片改成 PNG，用来核对 BSCScan 是否只是不收 WebP。
 * 默认只打印。--apply 才用 .env 的 TEST_PRIVATE_KEY 调用 setImageURI。
 * 新图片必须已经能从公网打开，否则浏览器会再记一次失败。
 *
 *   npm run nft:image
 *   npm run nft:image -- --apply
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_URI = "https://test.freedao.life/media/nomad/rwa-nft-pass.png";
const ENV_FILE = process.env.NEMO_ENV_FILE || new URL("../.env", import.meta.url);
const abi = parseAbi([
  "function owner() view returns (address)",
  "function imageURI() view returns (string)",
  "function nextId() view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function setImageURI(string imageURI_)",
]);

function readEnv(file) {
  return parseEnv(readFileSync(file, "utf8"));
}

async function imageReady(uri) {
  const response = await fetch(uri, { method: "HEAD" });
  const type = response.headers.get("content-type") || "";
  return { ok: response.ok && type.startsWith("image/png"), status: response.status, type };
}

function sendImage(cast, { nft, uri, rpc, privateKey }) {
  const result = spawnSync(
    cast,
    ["send", nft, "setImageURI(string)", uri, "--rpc-url", rpc, "--private-key", privateKey, "--json"],
    { encoding: "utf8" },
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (output.includes(privateKey)) throw new Error("设置失败，输出里含有私钥，已中止");
  if (result.status !== 0) throw new Error(`setImageURI 失败\n${output.trim()}`);
  const receipt = JSON.parse(result.stdout);
  if (BigInt(receipt.status) !== 1n || !receipt.transactionHash) throw new Error("没有成功回执");
  return receipt.transactionHash;
}

function imageFromTokenUri(tokenUri) {
  const prefix = "data:application/json;base64,";
  if (!tokenUri.startsWith(prefix)) return null;
  const json = JSON.parse(Buffer.from(tokenUri.slice(prefix.length), "base64").toString("utf8"));
  return json.image || null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const fileEnv = readEnv(ENV_FILE);
  const rpc = fileEnv.BSC_TESTNET_RPC;
  const nftRaw = fileEnv.BSC_TESTNET_NFT;
  const privateKey = fileEnv.TEST_PRIVATE_KEY;
  const uri = process.env.NFT_IMAGE_URI || DEFAULT_URI;
  if (!rpc || !nftRaw || !privateKey) throw new Error("缺少 BSC_TESTNET_RPC、BSC_TESTNET_NFT 或 TEST_PRIVATE_KEY");
  if (!uri.startsWith("https://") || !uri.endsWith(".png")) throw new Error("图片地址必须是 https 的 .png");

  const nft = getAddress(nftRaw);
  const account = privateKeyToAccount(privateKey);
  const client = createPublicClient({ transport: http(rpc) });
  if ((await client.getChainId()) !== 97) throw new Error("RPC不是测试网97");
  const [owner, current, nextId] = await Promise.all([
    client.readContract({ address: nft, abi, functionName: "owner" }),
    client.readContract({ address: nft, abi, functionName: "imageURI" }),
    client.readContract({ address: nft, abi, functionName: "nextId" }),
  ]);
  if (getAddress(owner) !== account.address) throw new Error("TEST_PRIVATE_KEY 不是 NFT owner");
  const remote = await imageReady(uri);
  console.log(JSON.stringify({
    nft,
    owner,
    nextId: nextId.toString(),
    current,
    next: uri,
    image: remote,
    apply,
  }, null, 2));
  if (!apply) {
    console.log("dry-run。PNG 已能打开后再加 --apply。");
    return;
  }
  if (!remote.ok && !force) {
    throw new Error(`PNG 还不能公开访问（${remote.status} ${remote.type}）。先部署网站，或确认后加 --force`);
  }
  if (current === uri) {
    console.log("链上已经是这个地址，未发送交易。");
    return;
  }

  const cast = `${homedir()}/.foundry/bin/cast`;
  const hash = sendImage(cast, { nft, uri, rpc, privateKey });
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
  const expectedData = encodeFunctionData({ abi, functionName: "setImageURI", args: [uri] });
  if (receipt.status !== "success" || getAddress(receipt.to) !== nft || tx.input !== expectedData) {
    throw new Error(`回执核对失败：${hash}`);
  }
  const updated = await client.readContract({ address: nft, abi, functionName: "imageURI" });
  if (updated !== uri) throw new Error(`imageURI 仍是 ${updated}`);
  let sample = null;
  if (nextId >= 3n) {
    const tokenUri = await client.readContract({ address: nft, abi, functionName: "tokenURI", args: [3n] });
    sample = imageFromTokenUri(tokenUri);
    if (sample !== uri) throw new Error(`tokenURI(3) 的图片不是新地址：${sample}`);
  }
  console.log(JSON.stringify({ hash, imageURI: updated, token3: sample }, null, 2));
}

await main();
