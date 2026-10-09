import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
import {updateEnvText, scopedEnv} from './testnet-env.mjs';
test('updates duplicate managed keys while preserving secret and DB lines verbatim',()=>{
 const original='# config\nTEST_PRIVATE_KEY="secret"\nDATABASE_URL="postgres://test/db"\nIDO_ADDRESS=old\nexport IDO_ADDRESS=stale\n';
 const text=updateEnvText(original,{IDO_ADDRESS:'new',START_BLOCK:'123'});
 assert.ok(text.includes('TEST_PRIVATE_KEY="secret"\nDATABASE_URL="postgres://test/db"'));
 assert.equal(parseEnv(text).IDO_ADDRESS,'new');
 assert.equal(parseEnv(text).START_BLOCK,'123');
 assert.equal(text.match(/^IDO_ADDRESS=/gm).length,1);
});
test('file values supersede inherited config and generic/mainnet signers are stripped',()=>{
 const old=process.env.PRIVATE_KEY;process.env.PRIVATE_KEY='inherited';
 try {const env=scopedEnv({RPC_URL:'from-file',PRIVATE_KEY:'file-secret',MAINNET_PRIVATE_KEY:'other'});assert.equal(env.RPC_URL,'from-file');assert.equal(env.PRIVATE_KEY,undefined);assert.equal(env.MAINNET_PRIVATE_KEY,undefined);}
 finally {if(old===undefined)delete process.env.PRIVATE_KEY;else process.env.PRIVATE_KEY=old;}
});
