import test from "node:test";
import assert from "node:assert/strict";
import { searchWeb } from "../web-search.mjs";

test("search exposes grounding sources and rejects ungrounded answers", async () => {
  const candidate = { content: { parts: [{ text: "Проверенный факт" }] }, groundingMetadata: {
    groundingChunks: [{ web: { uri: "https://example.org/source", title: "Источник" } }, { web: { uri: "javascript:alert(1)" } }],
  } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ candidates: [candidate] }) });
  const result = await searchWeb("Запрос", { apiKey: "test", fetchImpl });
  assert.equal(result.available, true); assert.equal(result.sources.length, 1);
  delete candidate.groundingMetadata;
  assert.equal((await searchWeb("Запрос", { apiKey: "test", fetchImpl })).available, false);
});
test("quota failures remain explicitly unavailable, never verified", async () => {
  const result = await searchWeb("Запрос", { apiKey: "test", fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  assert.equal(result.available, false); assert.match(result.error, /квота/);
});
