import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemInstruction,
  resolveConversationConfig,
} from "../public/persona.js";

const fixedNow = new Date("2026-09-17T12:00:00.000Z");

test("explicit mode forces profanity in every answer", () => {
  const config = resolveConversationConfig("explicit", "off");
  assert.equal(config.mode, "explicit");
  assert.equal(config.profanity, "always");

  const instruction = buildSystemInstruction({
    mode: "explicit",
    profanity: "off",
    now: fixedNow,
    timezone: "Europe/Amsterdam",
  });
  assert.match(instruction, /Режим: «Матерный друг»/);
  assert.match(instruction, /ненормативн[а-яё]+ лексик[а-яё]+ обязательна в КАЖДОМ ответе/i);
  assert.match(instruction, /не проси собеседника не ругаться/i);
});

test("roast mode keeps its consent-based battle style", () => {
  const config = resolveConversationConfig("roast", "off");
  assert.equal(config.profanity, "roast");
  assert.match(config.profanityDefinition.instruction, /заранее согласился/i);
});

test("regular modes respect the selected profanity level", () => {
  const config = resolveConversationConfig("friend", "off");
  assert.equal(config.profanity, "off");
  assert.match(config.profanityDefinition.instruction, /Не используй ненормативную лексику/i);
});
