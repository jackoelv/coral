#!/usr/bin/env node
/**
 * Move one wallet's umbrella onto a volume parent and subtract that umbrella
 * from the chain referrer's team_wei once. Direct rewards, team rewards and
 * claims stay. The chain referrer column stays. Dry run unless --apply.
 *
 * This run is JACK_BNB 15Cb → Admin_OKX. 强子's team must land on 45,030 USDT.
 * A later 0号线 is another row in SPLITS, then the same command.
 *
 *   npm run volume:split
 *   npm run volume:split -- --apply
 */
import { writeFileSync } from "node:fs";
import pg from "pg";
import { getAddress } from "viem";
import { contracts, readMainnetEnv, runPath, selectedDatabase } from "./lib/mainnet.mjs";
import { ensureSchema, lockName, tryLock, unlock } from "./lib/reward-db.mjs";

const APPLY = process.argv.includes("--apply");
const UNIT = 10n ** 18n;
const CHAIN_ID = 56;
const JACK = getAddress("0xB6c3CcdA14a5e3a82C3788e8c7B0Da1f217115Cb");
const ADMIN = getAddress("0xD25FFDaB817a1961E7c3224403d54a0182550968");
const QIANG = getAddress("0x450fF060Dd6F9Ab91218A505a034a387836E27a5");
const SPLITS = [
  {
    wallet: JACK,
    parent: ADMIN,
    chainReferrer: QIANG,
    note: "JACK_BNB",
    subtreeWei: 6701n * UNIT,
    referrerTeamWei: 45030n * UNIT,
  },
];

function fmt(wei) {
  const value = BigInt(wei);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / UNIT).toString();
  const fraction = (abs % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

async function readAccount(client, ido, wallet) {
  const { rows } = await client.query(
    `SELECT wallet, referrer, self_wei, team_wei, team_reward_wei, historical_team_reward_wei, direct_wei, claimed_wei
     FROM coral_team_account WHERE chain_id = $1 AND ido_address = $2 AND wallet = $3`,
    [CHAIN_ID, ido, wallet],
  );
  if (!rows[0]) throw new Error(`${wallet} 不在 coral_team_account`);
  const row = rows[0];
  return {
    wallet: getAddress(row.wallet),
    referrer: row.referrer ? getAddress(row.referrer) : null,
    selfWei: BigInt(row.self_wei),
    teamWei: BigInt(row.team_wei),
    teamRewardWei: BigInt(row.team_reward_wei),
    historicalTeamRewardWei: BigInt(row.historical_team_reward_wei || 0),
    directWei: BigInt(row.direct_wei),
    claimedWei: BigInt(row.claimed_wei),
  };
}

function sameBook(before, after) {
  return before.directWei === after.directWei
    && before.teamRewardWei === after.teamRewardWei
    && before.historicalTeamRewardWei === after.historicalTeamRewardWei
    && before.claimedWei === after.claimedWei
    && before.referrer === after.referrer
    && before.selfWei === after.selfWei;
}

const env = readMainnetEnv();
const db = selectedDatabase(env);
if (db.name !== "production") throw new Error("这次只改正式库 production");
const ido = getAddress(contracts(env).IDO);
console.log(`这次用正式库 ${db.name}（${db.target.host}/${db.target.database}），金库 ${ido}。不改链上推荐人，不发 root。`);

const client = new pg.Client({
  connectionString: db.url,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});
await client.connect();
const name = lockName(CHAIN_ID, ido);
let locked = false;
try {
  await ensureSchema(client);
  for (const split of SPLITS) {
    const existing = await client.query(
      `SELECT volume_parent, note, adjusted_wei FROM coral_volume_root
       WHERE chain_id = $1 AND ido_address = $2 AND wallet = $3`,
      [CHAIN_ID, ido, split.wallet],
    );
    const row = existing.rows[0] || null;
    const account = await readAccount(client, ido, split.wallet);
    const referrer = await readAccount(client, ido, split.chainReferrer);
    const parent = await readAccount(client, ido, split.parent);
    const subtree = account.selfWei + account.teamWei;
    if (row?.adjusted_wei != null && row.adjusted_wei !== "") {
      if (getAddress(row.volume_parent) !== split.parent || BigInt(row.adjusted_wei) !== split.subtreeWei) {
        throw new Error(`${split.wallet} 已经调整过，但记录和这次要减的 ${fmt(split.subtreeWei)} 不一致，停止`);
      }
      console.log(`${split.note} 已经挂到计算上级，减过 ${fmt(row.adjusted_wei)}。链上推荐人伞下现在是 ${fmt(referrer.teamWei)}。不再减第二次。`);
      continue;
    }
    if (row) throw new Error(`${split.wallet} 已有计算上级但没有减过伞下，停止，避免和这次的数字搞混`);
    if (account.referrer !== split.chainReferrer) throw new Error(`${split.note} 的链上推荐人是 ${account.referrer}，不是 ${split.chainReferrer}`);
    if (subtree !== split.subtreeWei) throw new Error(`${split.note} 整支是 ${fmt(subtree)}，这次要求 ${fmt(split.subtreeWei)}`);
    if (referrer.teamWei - subtree !== split.referrerTeamWei) {
      throw new Error(`链上推荐人伞下 ${fmt(referrer.teamWei)} 减去 ${fmt(subtree)} 是 ${fmt(referrer.teamWei - subtree)}，不是 ${fmt(split.referrerTeamWei)}`);
    }
    console.log(`${split.note} ${split.wallet} 整支 ${fmt(subtree)}。链上推荐人仍是 ${split.chainReferrer}，伞下从 ${fmt(referrer.teamWei)} 减到 ${fmt(split.referrerTeamWei)}。`);
    console.log(`计算上级 ${split.parent} 的伞下保持 ${fmt(parent.teamWei)}。直推 ${fmt(referrer.directWei)}，网体奖 ${fmt(referrer.teamRewardWei)}，已领 ${fmt(referrer.claimedWei)} 都不改。`);
    if (!APPLY) {
      console.log("这是预览。加上 --apply 才会写入。");
      continue;
    }
    if (!locked) {
      locked = await tryLock(client, name);
      if (!locked) throw new Error("索引或发布进程占用着这把锁，这次不写");
    }
    await client.query("BEGIN");
    try {
      const again = await readAccount(client, ido, split.chainReferrer);
      const walletAgain = await readAccount(client, ido, split.wallet);
      const parentAgain = await readAccount(client, ido, split.parent);
      if (again.teamWei !== referrer.teamWei || walletAgain.selfWei + walletAgain.teamWei !== subtree) {
        throw new Error("读到的伞下和开写前不一致，回滚");
      }
      const updated = await client.query(
        `UPDATE coral_team_account SET team_wei = $4, updated_at = now()
         WHERE chain_id = $1 AND ido_address = $2 AND wallet = $3 AND team_wei = $5`,
        [CHAIN_ID, ido, split.chainReferrer, split.referrerTeamWei.toString(), referrer.teamWei.toString()],
      );
      if (updated.rowCount !== 1) throw new Error("没有改到链上推荐人的伞下，回滚");
      await client.query(
        `INSERT INTO coral_volume_root (chain_id, ido_address, wallet, volume_parent, note, adjusted_wei, adjusted_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [CHAIN_ID, ido, split.wallet, split.parent, split.note, split.subtreeWei.toString()],
      );
      const afterReferrer = await readAccount(client, ido, split.chainReferrer);
      const afterWallet = await readAccount(client, ido, split.wallet);
      const afterParent = await readAccount(client, ido, split.parent);
      if (afterReferrer.teamWei !== split.referrerTeamWei) throw new Error("减完的伞下不对，回滚");
      if (!sameBook(referrer, afterReferrer)) throw new Error("链上推荐人的直推、网体奖或已领被改动，回滚");
      if (!sameBook(account, afterWallet) || afterWallet.teamWei !== account.teamWei) throw new Error("0 号线自己的账被改动，回滚");
      if (afterParent.teamWei !== parentAgain.teamWei || !sameBook(parent, afterParent)) throw new Error("计算上级的伞下被改动，回滚");
      await client.query("COMMIT");
      const receipt = {
        status: "applied",
        database: db.name,
        host: db.target.host,
        ido,
        wallet: split.wallet,
        volumeParent: split.parent,
        chainReferrer: split.chainReferrer,
        subtreeWei: split.subtreeWei.toString(),
        referrerTeamWei: split.referrerTeamWei.toString(),
        at: new Date().toISOString(),
      };
      const path = runPath("volume-root-15cb.json");
      writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
      console.log(`已写入。链上推荐人伞下现在是 ${fmt(split.referrerTeamWei)}。回执 ${path}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  if (locked) await unlock(client, name).catch(() => {});
  await client.end();
}
