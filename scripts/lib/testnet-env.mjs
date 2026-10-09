import { readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

export const envPath = resolve('.env');
export function readTestnetEnv() { return parseEnv(readFileSync(envPath, 'utf8')); }
export function updateEnvText(text, updates) {
  const remaining = new Set(Object.keys(updates));
  const rows = text.split('\n').map(line => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!Object.hasOwn(updates, key)) return line;
    if (!remaining.has(key)) return ''; // Remove duplicate definitions of managed keys.
    remaining.delete(key);
    return `${key}=${JSON.stringify(String(updates[key]))}`;
  });
  for (const key of remaining) rows.push(`${key}=${JSON.stringify(String(updates[key]))}`);
  return rows.join('\n').replace(/\n*$/, '\n');
}
export function saveTestnetEnv(updates) {
  const text = readFileSync(envPath, 'utf8');
  const backup = `${envPath}.backup-${Date.now()}`;
  copyFileSync(envPath, backup); chmodSync(backup, 0o600);
  const temp = `${envPath}.tmp-${process.pid}`;
  writeFileSync(temp, updateEnvText(text, updates), {mode: 0o600, flag: 'wx'});
  renameSync(temp, envPath);
  console.log('.env 已更新；原配置备份已保留（含密钥，勿上传）。');
}
export function scopedEnv(config) {
  const env = {...process.env, ...config};
  delete env.PRIVATE_KEY;
  delete env.MAINNET_PRIVATE_KEY;
  return env;
}
