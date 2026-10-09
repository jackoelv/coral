#!/usr/bin/env node
/**
 * Export FreeDao nomad users + confirmed IDO volume into import-data.json.
 *
 *   DATABASE_URL=postgres://... node scripts/export-freedao.mjs --network bscMainnet
 *   node scripts/export-freedao.mjs --in snapshot.json --out import-data.json --network local
 *
 * --network local|bscTestnet rewrites wallets to deterministic simulated addresses
 * and writes an address map. bscMainnet keeps the database wallets.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareImport } from "./lib/tree.mjs";
import { remapForNetwork } from "./lib/addresses.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const outPath = resolve(arg("--out", "import-data.json"));
const inPath = arg("--in", null);
const network = arg("--network", "bscMainnet");

async function loadFromPostgres() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Set DATABASE_URL or pass --in snapshot.json");
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const users = await client.query(`
      SELECT id, "walletAddress" AS wallet, "inviteCode" AS invite, "referrerId" AS referrer_id
      FROM nomad_users
    `);
    const volumes = await client.query(`
      SELECT "userId" AS user_id, COALESCE(SUM("amountUsdt"), 0)::bigint AS self_usdt
      FROM nomad_contribution_orders
      WHERE status = 'confirmed'
      GROUP BY "userId"
    `);
    const orders = await client.query(`
      SELECT "userId" AS user_id, "amountUsdt" AS amount_usdt,
             COALESCE("confirmedAt", "createdAt") AS confirmed_at
      FROM nomad_contribution_orders
      WHERE status = 'confirmed'
      ORDER BY COALESCE("confirmedAt", "createdAt") ASC
    `);
    const vol = new Map(volumes.rows.map((r) => [r.user_id, Number(r.self_usdt)]));
    const ordersById = new Map();
    for (const row of orders.rows) {
      const list = ordersById.get(row.user_id) || [];
      list.push({
        usdt: Number(row.amount_usdt),
        confirmedAt: new Date(row.confirmed_at).toISOString(),
      });
      ordersById.set(row.user_id, list);
    }
    return {
      users: users.rows.map((r) => ({
        id: r.id,
        wallet: r.wallet,
        inviteCode: r.invite,
        referrerId: r.referrer_id,
        selfUsdt: vol.get(r.id) || 0,
      })),
      ordersById,
    };
  } finally {
    await client.end();
  }
}

function loadFromFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.users)) return data.users;
  throw new Error("JSON must be an array or { users: [...] }");
}

const loaded = inPath
  ? { users: loadFromFile(inPath), ordersById: new Map() }
  : await loadFromPostgres();
if (inPath) {
  for (const user of loaded.users) {
    if (Array.isArray(user.orders)) loaded.ordersById.set(user.id, user.orders);
  }
}
const prepared = prepareImport(loaded.users);
const remapped = remapForNetwork(prepared.records, network);
for (const record of remapped.records) {
  record.orders = loaded.ordersById.get(record.id) || [];
}
const mapPath = resolve(arg("--map", `${outPath}.addresses.json`));

const payload = {
  generatedAt: new Date().toISOString(),
  source: inPath ? resolve(inPath) : "DATABASE_URL",
  network,
  ok: prepared.ok,
  stats: prepared.stats,
  errors: prepared.errors,
  volumeMismatches: prepared.volumeMismatches,
  records: remapped.records,
};

if (network !== "bscMainnet") {
  writeFileSync(
    mapPath,
    JSON.stringify({ network, generatedAt: payload.generatedAt, map: remapped.map }, null, 2),
  );
  console.log(`wrote address map ${mapPath}`);
}

writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`wrote ${outPath}`);
console.log(JSON.stringify(prepared.stats, null, 2));
if (!prepared.ok) {
  console.error("dry-run found errors; not safe to apply");
  console.error(JSON.stringify({ errors: prepared.errors, volumeMismatches: prepared.volumeMismatches }, null, 2));
  process.exit(1);
}
