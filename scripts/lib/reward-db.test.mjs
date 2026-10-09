import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_SQL, advisoryKey, lockName } from "./reward-db.mjs";

test("account, root and proof tables are keyed by vault address", () => {
  assert.match(SCHEMA_SQL, /nemo_team_account[\s\S]*?PRIMARY KEY \(chain_id, ido_address, wallet\)/);
  assert.match(SCHEMA_SQL, /nemo_team_root[\s\S]*?PRIMARY KEY \(chain_id, ido_address, root\)/);
  assert.match(SCHEMA_SQL, /nemo_team_proof[\s\S]*?PRIMARY KEY \(chain_id, ido_address, root, wallet\)/);
});

test("advisory lock key is stable and fits two int32 values", () => {
  const name = lockName(56, "0xA513E6E4b8f2a923D98304ec87F64353C4D5C853");
  const again = advisoryKey(name);
  assert.deepEqual(advisoryKey(name), again);
  assert.notDeepEqual(advisoryKey(name), advisoryKey(lockName(56, "0x0000000000000000000000000000000000000001")));
  for (const part of again) {
    assert.equal(part, part | 0);
  }
});
