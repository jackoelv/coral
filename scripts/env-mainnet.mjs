#!/usr/bin/env node
/**
 * Creates .env.mainnet from .env.mainnet.example and a fresh one-time deployer key.
 * Default prints what would be written. --apply writes the file (chmod 600).
 * An existing private key is never overwritten. A retired deployer is never regenerated.
 *
 *   npm run env:mainnet
 *   npm run env:mainnet -- --apply
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FIXED_ENV, MAINNET_ENV, MAINNET_EXAMPLE, RUN_DIR, saveMainnetEnv } from "./lib/mainnet.mjs";
import { updateEnvText } from "./lib/testnet-env.mjs";

const apply = process.argv.includes("--apply");
const template = parseEnv(readFileSync(MAINNET_EXAMPLE, "utf8"));
const exists = existsSync(MAINNET_ENV);
const current = exists ? parseEnv(readFileSync(MAINNET_ENV, "utf8")) : {};

const updates = { ...FIXED_ENV };
for (const key of Object.keys(template)) if (!(key in current) && !(key in updates)) updates[key] = template[key];
let generated = null;
if (!current.MAINNET_PRIVATE_KEY) {
  if (current.MAINNET_DEPLOYER) {
    throw new Error(`MAINNET_DEPLOYER=${current.MAINNET_DEPLOYER} 已退役（私钥已清空）。不要再生成新部署账户，除非你确认要重新部署整套合约。`);
  }
  generated = generatePrivateKey();
  updates.MAINNET_PRIVATE_KEY = generated;
  updates.MAINNET_DEPLOYER = privateKeyToAccount(generated).address;
} else {
  updates.MAINNET_DEPLOYER = privateKeyToAccount(current.MAINNET_PRIVATE_KEY).address;
}

console.log(JSON.stringify({
  file: MAINNET_ENV,
  exists,
  fixed: FIXED_ENV,
  addKeys: Object.keys(updates).filter((k) => !(k in current) && k !== "MAINNET_PRIVATE_KEY"),
  newDeployerKey: Boolean(generated),
  deployer: generated ? "(--apply 时生成)" : updates.MAINNET_DEPLOYER,
  apply,
}, null, 2));
if (!apply) {
  console.log("预览完成，没有写文件。确认后：npm run env:mainnet -- --apply");
  process.exit(0);
}

if (!exists) {
  writeFileSync(MAINNET_ENV, updateEnvText(readFileSync(MAINNET_EXAMPLE, "utf8"), updates), { mode: 0o600, flag: "wx" });
  chmodSync(MAINNET_ENV, 0o600);
  console.log(`已生成 ${MAINNET_ENV}（权限 600）。`);
} else {
  saveMainnetEnv(updates);
}
console.log(`MAINNET_DEPLOYER=${updates.MAINNET_DEPLOYER}`);
console.log(`运行目录 ${RUN_DIR} 已在 .gitignore。`);
console.log("下一步手填 BSC_MAINNET_RPC、MAINNET_OWNER。MAINNET_PUBLISHER 和 MAX_ROOT_INCREASE_WEI 在 publisher:mainnet 之前填。用手机 imToken 签名前再填 WALLETCONNECT_PROJECT_ID（Reown 项目编号，不是私钥）。数据库和 BSCSCAN_API_KEY 按对应步骤再填。");
console.log("然后跑 npm run deploy:mainnet 看 gas 估算，用币安钱包按 2 倍给 MAINNET_DEPLOYER 转 BNB。");
