import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildSystemInstruction,
  resolveConversationConfig,
} from "../public/persona.js";

const fixedNow = new Date("2026-09-17T12:00:00.000Z");

test("default persona is the explicit friend with strong profanity", () => {
  const config = resolveConversationConfig();
  assert.equal(config.mode, "explicit");
  assert.equal(config.profanity, "always");
  const instruction = buildSystemInstruction();
  assert.match(instruction, /Режим: «Матерный друг»/);
  assert.match(instruction, /мат обязателен в каждом ответе/i);
});

test("explicit mode remains distinct and locks profanity in every answer", () => {
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

test("page defaults agree with the restored persona and preserve Aoede", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /value="explicit" selected>Матерный друг — жёстко и по теме/);
  assert.match(html, /value="always" selected/);
  assert.match(html, /value="Aoede" selected/);
});

test("listening mode forbids unsolicited advice", () => {
  const instruction = buildSystemInstruction({ mode: "listen", profanity: "off", now: fixedNow });
  assert.match(instruction, /Не давай советов/i);
  assert.match(instruction, /пока собеседник прямо не попросит/i);
});

test("planning mode returns one actionable next step", () => {
  const instruction = buildSystemInstruction({ mode: "plan", profanity: "moderate", now: fixedNow });
  assert.match(instruction, /один ближайший выполнимый шаг/i);
  assert.match(instruction, /срок, ограничения/i);
  assert.match(instruction, /сразу назови первое действие/i);
});

test("teasing mode stays consent-based and does not attack the person", () => {
  const config = resolveConversationConfig("roast", "moderate");
  assert.equal(config.profanity, "moderate");
  assert.match(config.modeDefinition.instruction, /заранее согласованная/i);
  assert.match(config.modeDefinition.instruction, /одной короткой, ясной/i);
  assert.match(config.modeDefinition.instruction, /Не называй собеседника тупым/i);
  assert.match(config.modeDefinition.instruction, /Не используй диагнозы/i);
});

test("battle mode locks strong profanity and targets the consenting opponent", () => {
  const config = resolveConversationConfig("battle", "off");
  assert.equal(config.mode, "battle");
  assert.equal(config.profanity, "always");
  assert.match(config.modeDefinition.instruction, /жёсткие прямые оскорбления/i);
  assert.match(config.modeDefinition.instruction, /Направляй панчи прямо на собеседника/i);
  assert.match(config.modeDefinition.instruction, /Никогда не упоминай и не оскорбляй родителей/i);
  assert.match(config.modeDefinition.instruction, /немедленно прекрати батл/i);
});

test("battle instructions override the general no-targeted-insults rule", () => {
  const instruction = buildSystemInstruction({ mode: "battle", profanity: "off", now: fixedNow });
  assert.match(instruction, /Режим: «Матерный батл»/);
  assert.match(instruction, /кроме заранее согласованного режима «Матерный батл»/i);
  assert.match(instruction, /действуют специальные правила этого режима/i);
});

test("legal mode asks one neutral jurisdiction question before analysis", () => {
  const instruction = buildSystemInstruction({ mode: "legal", profanity: "off", now: fixedNow });
  assert.match(instruction, /задай ровно один вопрос/i);
  assert.match(instruction, /Не угадывай страну/i);
});

test("regular modes respect the selected profanity level", () => {
  const config = resolveConversationConfig("friend", "off");
  assert.equal(config.profanity, "off");
  assert.match(config.profanityDefinition.instruction, /Не используй ненормативную лексику/i);
});
