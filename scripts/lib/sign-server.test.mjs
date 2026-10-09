import test from "node:test";
import assert from "node:assert/strict";
import { renderSignPage } from "./sign-server.mjs";

test("sign page offers imToken and still sends the extension transaction with gas", () => {
  const html = renderSignPage("abc");
  assert.match(html, /用手机 imToken 签名/);
  assert.match(html, /signImtoken/);
  assert.match(html, /用浏览器插件签/);
  assert.match(html, /eth_sendTransaction/);
  assert.match(html, /gas:pre\.gas/);
  assert.match(html, /accounts\[0\]/);
  assert.doesNotMatch(html, /writeContract/);
});
