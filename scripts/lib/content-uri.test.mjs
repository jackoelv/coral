import test from "node:test";
import assert from "node:assert/strict";
import { contentUriFor, decideContentUriPublish, rootFileName } from "./content-uri.mjs";

test("content URI joins an https directory and the public file name", () => {
  const file = rootFileName("0xAB", "0xcd");
  assert.equal(file, "56-0xab-0xcd.json");
  assert.equal(contentUriFor("https://files.example/roots/", file), "https://files.example/roots/56-0xab-0xcd.json");
});

test("content URI rejects a missing, http, or non-directory base", () => {
  assert.throws(() => contentUriFor("", "a.json"), /未设置/);
  assert.throws(() => contentUriFor("http://files.example/roots/", "a.json"), /https/);
  assert.throws(() => contentUriFor("https://files.example/roots", "a.json"), /结尾/);
});

test("content URI publish never changes a different root", () => {
  assert.equal(decideContentUriPublish({ sameRoot: false, chainUri: "", nextUri: "https://files.example/a.json" }).action, "refuse");
  assert.equal(decideContentUriPublish({ sameRoot: true, chainUri: "https://files.example/a.json", nextUri: "https://files.example/a.json" }).action, "skip");
  assert.equal(decideContentUriPublish({ sameRoot: true, chainUri: "", nextUri: "https://files.example/a.json" }).action, "sign");
});
