#!/usr/bin/env node
/**
 * 把新测试网的公开合约地址写进 FreeDao 的 Vercel Preview。
 * 不上传私钥、数据库连接串、CRON_SECRET。不会改 Production。
 * 默认只打印。--apply 才调用 vercel env。
 *
 *   node scripts/upload-testnet-vercel-preview.mjs
 *   node scripts/upload-testnet-vercel-preview.mjs --apply
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { previewEnvUpdates } from "./lib/testnet-ops.mjs";

const ENV_FILE = process.env.NEMO_ENV_FILE || new URL("../.env", import.meta.url);
const PROJECT_DIR = process.env.VERCEL_PROJECT_DIR || "/Users/jack/git/github/FreeDao";

function readEnv(file) {
  const text = readFileSync(file, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    env[line.slice(0, index)] = line.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  return env;
}

function upload(name, value) {
  const result = spawnSync("vercel", ["env", "add", name, "preview", "--force", "--cwd", PROJECT_DIR], {
    input: value,
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    throw new Error(`${name} 上传失败\n${output}`);
  }
  console.log(output.split("\n").at(-1) || `${name} 已写入 preview`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (process.argv.some((arg) => arg === "production" || arg === "prod")) {
    throw new Error("这个脚本只写 Preview，不写 Production");
  }
  const updates = previewEnvUpdates(readEnv(ENV_FILE));
  for (const [name, value] of Object.entries(updates)) {
    console.log(`${name}=${value}`);
  }
  if (!apply) {
    console.log("dry-run。确认后加 --apply 才会写入 Vercel Preview。写完后要重新部署 Preview，NEXT_PUBLIC_ 才会进前端包。");
    return;
  }
  for (const [name, value] of Object.entries(updates)) upload(name, value);
  console.log("Preview 环境变量已更新。重新部署 Preview 后，前端才会使用新合约。Preview 没有定时索引，网体业绩在本地跑 index:rewards。");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
