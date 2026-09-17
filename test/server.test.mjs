import test from "node:test";
import assert from "node:assert/strict";

import { createTokenPayload, parseEnv, resolvePublicFile, searchKnowledge } from "../server.mjs";

test("parseEnv reads values and ignores comments", () => {
  assert.deepEqual(
    parseEnv("# comment\nGEMINI_API_KEY='secret'\nPORT=3000\nEMPTY=\n"),
    { GEMINI_API_KEY: "secret", PORT: "3000", EMPTY: "" },
  );
});

test("ephemeral token is single-use and short-lived", () => {
  const payload = createTokenPayload(Date.UTC(2026, 8, 16, 12, 0, 0));
  assert.equal(payload.uses, 1);
  assert.equal(payload.newSessionExpireTime, "2026-09-16T12:01:00.000Z");
  assert.equal(payload.expireTime, "2026-09-16T12:30:00.000Z");
});

test("static file resolver blocks traversal", () => {
  assert.equal(resolvePublicFile("/../../server.mjs"), null);
  assert.match(resolvePublicFile("/styles.css"), /public\/styles\.css$/);
});

test("knowledge search ranks product facts and omits unmatched records", () => {
  const records = [
    { id: "voice", title: "Голоса", keywords: ["голос"], content: "Пять голосов." },
    { id: "privacy", title: "Приватность", keywords: ["аудио"], content: "Аудио не сохраняется." },
  ];
  assert.deepEqual(searchKnowledge("сохраняется ли аудио", records), [
    { id: "privacy", title: "Приватность", content: "Аудио не сохраняется." },
  ]);
  assert.deepEqual(searchKnowledge("оплата", records), []);
});
