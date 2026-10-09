#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readTestnetEnv, scopedEnv } from './lib/testnet-env.mjs';
const [script,...args] = process.argv.slice(2);
const allowed = new Set(['index-rewards.mjs','publish-root.mjs','verify-root.mjs']);
if (!allowed.has(script)) throw new Error('不支持的脚本');
const env = scopedEnv(readTestnetEnv());
// Publisher jobs receive only the publisher key; inherited signer keys are removed.
if (script === 'publish-root.mjs') {
  for (const key of Object.keys(env)) if (key.includes('PRIVATE_KEY') && key!=='PUBLISHER_PRIVATE_KEY') delete env[key];
}
const result = spawnSync(process.execPath,[`scripts/${script}`,...args],{env,stdio:'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
