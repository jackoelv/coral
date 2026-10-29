import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { batchTransferPlan, activityCode, parseBatchCsv } from './ckey-batch.mjs';
import { airdropAccount, asTerminalPlan, assertTerminalPlan, TERMINAL_CHANNEL } from './ckey-batch-send.mjs';

const KEY = `0x${'11'.repeat(32)}`;
const OTHER = `0x${'22'.repeat(32)}`;
const FROM = privateKeyToAccount(KEY).address;
const TOKEN = '0x4444444444444444444444444444444444444444';
const A = '0x1111111111111111111111111111111111111111';

function sample() {
  const parsed = parseBatchCsv(`address,amount\n${A},100`, FROM, '终端验收.csv');
  return asTerminalPlan(batchTransferPlan({ from: FROM, token: TOKEN, ...parsed, code: activityCode(parsed.name) }));
}

test('airdrop key is a dedicated account and cannot be the deployer key', () => {
  assert.equal(airdropAccount({ CKEY_AIRDROP_PRIVATE_KEY: KEY.slice(2) }).address, FROM);
  assert.throws(() => airdropAccount({ CKEY_AIRDROP_PRIVATE_KEY: KEY, MAINNET_PRIVATE_KEY: KEY }), /不能复用/);
  assert.throws(() => airdropAccount({ CKEY_AIRDROP_PRIVATE_KEY: KEY, MAINNET_PRIVATE_KEY: KEY.slice(2) }), /不能复用/);
  assert.throws(() => airdropAccount({ CKEY_AIRDROP_PRIVATE_KEY: KEY, MAINNET_DEPLOYER: FROM }), /部署账户/);
  assert.equal(airdropAccount({ CKEY_AIRDROP_PRIVATE_KEY: KEY, MAINNET_PRIVATE_KEY: OTHER }).address, FROM);
  assert.throws(() => airdropAccount({}), /CKEY_AIRDROP_PRIVATE_KEY/);
});

test('terminal plans are marked and browser plans are refused', () => {
  const plan = sample();
  assert.equal(plan.meta.channel, TERMINAL_CHANNEL);
  assert.equal(assertTerminalPlan(plan, FROM), plan);
  const browser = batchTransferPlan({ from: FROM, token: TOKEN, ...parseBatchCsv(`address,amount\n${A},100`, FROM, '终端验收.csv'), code: activityCode('终端验收') });
  assert.throws(() => assertTerminalPlan(browser, FROM), /浏览器计划/);
  assert.throws(() => assertTerminalPlan(plan, privateKeyToAccount(OTHER).address), /不一致/);
});

test('terminal sender does not open a browser or call writeContract', () => {
  const source = [
    readFileSync(new URL('./ckey-batch-send.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../ckey-batch-send.mjs', import.meta.url), 'utf8'),
  ].join('\n');
  assert.equal(source.includes('writeContract'), false);
  assert.equal(source.includes('servePlan'), false);
  assert.equal(source.includes('runAirdrop'), false);
  assert.match(source, /signTransaction/);
  assert.match(source, /sendRawTransaction/);
  assert.match(source, /recordConfirmed/);
});
