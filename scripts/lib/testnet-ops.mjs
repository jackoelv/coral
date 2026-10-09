import { getAddress } from "viem";

/** Addresses only. The wallet file's private keys are never returned. */
export function usdtMintTargets(doc) {
  if (!Array.isArray(doc?.wallets) || doc.wallets.length === 0) {
    throw new Error("钱包文件里没有地址");
  }
  return doc.wallets.map((row, i) => {
    if (!row?.address) throw new Error(`第 ${i + 1} 个钱包缺少 address`);
    return { index: row.index ?? i + 1, address: getAddress(row.address) };
  });
}

export const TESTNET_CHAIN_ID = 97;
const PRODUCTION_DB_HOST = "ep-autumn-cake";
const TEST_DB_HOST = "ep-empty-king";

/** Website rows that make the test site disagree with a freshly deployed vault. */
export const SITE_RESET_TABLES = [
  "activity_rewards",
  "activity_draws",
  "activity_points_tx",
  "activity_referrals",
  "activity_task_completions",
  "activity_social_accounts",
  "activity_risk_logs",
  "activity_oauth_states",
  "nomad_chain_snapshots",
  "nomad_referral_rewards",
  "nomad_node_applications",
  "nomad_contribution_orders",
  "nomad_ambassador_applications",
  "nomad_token_allocations",
  "nomad_withdrawals",
  "nomad_wallet_nonces",
  "nomad_users",
];

/** Chain-97 index rows for every vault. Week boundaries stay. */
export const CHAIN_INDEX_TABLES = [
  { name: "coral_team_proof", chainColumn: "chain_id" },
  { name: "coral_team_root", chainColumn: "chain_id" },
  { name: "coral_team_account", chainColumn: "chain_id" },
  { name: "coral_indexer_state", chainColumn: "chain_id" },
  { name: "coral_invite_cache", chainColumn: '"chainId"' },
];

const PREVIEW_SOURCES = [
  ["NEXT_PUBLIC_CHAIN_NETWORK", () => "testnet"],
  ["NEXT_PUBLIC_NEMO_NETWORK", () => "bscTestnet"],
  ["NEXT_PUBLIC_BSC_TESTNET_USDT", (env) => getAddress(required(env, "BSC_TESTNET_USDT"))],
  ["NEXT_PUBLIC_BSC_TESTNET_IDO", (env) => getAddress(required(env, "BSC_TESTNET_IDO"))],
  ["NEXT_PUBLIC_BSC_TESTNET_REWARDS", (env) => getAddress(required(env, "BSC_TESTNET_REWARDS"))],
  ["NEXT_PUBLIC_BSC_TESTNET_INTEREST", (env) => getAddress(required(env, "BSC_TESTNET_INTEREST"))],
  ["NEXT_PUBLIC_BSC_TESTNET_NFT", (env) => getAddress(required(env, "BSC_TESTNET_NFT"))],
  ["INDEX_START_BLOCK", (env) => startBlock(env)],
  ["NEMO_RPC_URL", (env) => rpcUrl(env)],
];

function required(env, key) {
  const value = (env[key] || "").trim();
  if (!value) throw new Error(`缺少 ${key}`);
  return value;
}

function startBlock(env) {
  const value = (env.INDEX_START_BLOCK || env.START_BLOCK || "").trim();
  if (!/^[1-9]\d*$/.test(value)) throw new Error("INDEX_START_BLOCK 必须是大于 0 的整数");
  return value;
}

function rpcUrl(env) {
  const value = required(env, "BSC_TESTNET_RPC");
  if (!value.startsWith("https://")) throw new Error("BSC_TESTNET_RPC 必须是 https 地址");
  return value;
}

export function databaseHost(databaseUrl) {
  return databaseTarget(databaseUrl).host;
}

/** Host, database name, user, and the connection string used to connect. */
export function databaseTarget(databaseUrl) {
  if (!databaseUrl) throw new Error("缺少 DATABASE_URL");
  const url = new URL(databaseUrl.replace(/^postgresql:/, "http:"));
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("数据库连接缺少库名");
  return {
    user: decodeURIComponent(url.username),
    host: url.hostname,
    database,
    connection: databaseUrl,
  };
}

/** Refuse production, any host other than the test database, and any chain other than BSC testnet. */
export function assertSafeReset({ databaseUrl, chainId, idoAddress }) {
  if (Number(chainId) !== TESTNET_CHAIN_ID) {
    throw new Error(`只允许重置 BSC 测试网 chain id ${TESTNET_CHAIN_ID}`);
  }
  const target = databaseTarget(databaseUrl);
  if (target.host.includes(PRODUCTION_DB_HOST)) throw new Error("这是正式库，已拒绝重置");
  if (!target.host.includes(TEST_DB_HOST)) throw new Error("只允许清理测试库 ep-empty-king");
  const ido = getAddress(idoAddress);
  return { ...target, ido, chainId: TESTNET_CHAIN_ID };
}

/** Preview-only public contract settings. Secrets stay out of this list. */
export function previewEnvUpdates(env) {
  const updates = {};
  for (const [name, read] of PREVIEW_SOURCES) updates[name] = read(env);
  return updates;
}
