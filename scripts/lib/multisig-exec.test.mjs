import test from "node:test";
import assert from "node:assert/strict";
import { parseSignerSelection, resolveAddress } from "./multisig-exec.mjs";

const rows = [
  { index: 17, address: "0x2d1fc830d6ea39fbd8ca0684b601c350d465aEB1" },
  { index: 18, address: "0x0E3b61C283B1A10D23Aee2088820c8C46cadB682" },
  { index: 19, address: "0x865616feF95FBeBd8c87ce70fFF1D3eCFD0072aE" },
  { index: 20, address: "0x5fb9fa20B90B4542a91487cd93817e7Fe78c87Bc" },
  { index: 5, address: "0x07c9f71f23B4f5B1d026f7C07fC9c3ab0791B661" },
];

test("省略 --signers 时用 17、18、19", () => {
  assert.deepEqual(parseSignerSelection(["exec"], rows), [17, 18, 19]);
});

test("可以用 index、地址或混写选定三个签名人", () => {
  assert.deepEqual(parseSignerSelection(["test", "--signers", "17,19,20"], rows), [17, 19, 20]);
  assert.deepEqual(parseSignerSelection([
    "test",
    "--signers=0x2d1fc830d6ea39fbd8ca0684b601c350d465aeb1,0x865616feF95FBeBd8c87ce70fFF1D3eCFD0072aE,0x5fb9fa20B90B4542a91487cd93817e7Fe78c87Bc",
  ], rows), [17, 19, 20]);
  assert.deepEqual(parseSignerSelection([
    "test",
    "--signers",
    "17,0x865616feF95FBeBd8c87ce70fFF1D3eCFD0072aE,20",
  ], rows), [17, 19, 20]);
});

test("签名人必须恰好三个且互不相同", () => {
  assert.throws(() => parseSignerSelection(["test", "--signers", "17,19"], rows), /恰好 3 个/);
  assert.throws(() => parseSignerSelection(["test", "--signers", "17,17,19"], rows), /各不相同/);
  assert.throws(() => parseSignerSelection([
    "test",
    "--signers",
    "0x0000000000000000000000000000000000000001,17,19",
  ], rows), /没有签名地址/);
});

test("目标可以是 index 或任意地址", () => {
  assert.equal(resolveAddress(rows, "5", "account"), "0x07c9f71f23B4f5B1d026f7C07fC9c3ab0791B661");
  assert.equal(
    resolveAddress(rows, "0x07c9f71f23b4f5b1d026f7c07fc9c3ab0791b661", "account"),
    "0x07c9f71f23B4f5B1d026f7C07fC9c3ab0791B661",
  );
});
