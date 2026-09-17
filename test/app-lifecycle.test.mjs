import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as persona from "../public/persona.js";
import * as memory from "../public/memory.js";
import { COMPANION_TOOLS } from "../public/companion-tools.js";

function fixture(fetchImpl = async () => ({ ok: true, json: async () => ({}) })) {
  function element() {
    const children = new Map();
    return { dataset: {}, value: "", textContent: "", style: { setProperty() {} },
      append() {}, appendChild() {}, remove() {}, setAttribute() {}, classList: { add() {} },
      querySelector: (selector) => {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
    };
  }
  const root = element();
  const document = { querySelector: root.querySelector, createElement: element, documentElement: element() };
  document.querySelector("#mode-select").value = "friend";
  document.querySelector("#profanity-select").value = "free";
  document.querySelector("#voice-select").value = "Puck";
  let stored = null;
  const window = { localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } } };
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\s*/gm, "").split('elements.button.addEventListener("click"')[0];
  const sent = [];
  class Socket { static OPEN = 1; constructor() { this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } addEventListener() {} close() {} }
  const ctx = vm.createContext({ ...persona, ...memory, COMPANION_TOOLS, document, window,
    fetch: fetchImpl, WebSocket: Socket, URL, AbortSignal, AbortController,
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, Intl, Date });
  vm.runInContext(source, ctx);
  const app = vm.runInContext("({ state, conversationContext, memoryStore, parseServerMessage, handleToolCall, refreshAfterForgetting, getSetupMessage })", ctx);
  app.state.sessionActive = true;
  app.state.websocket = new Socket();
  app.state.playback = { clear() {}, completeTurn() {} };
  return { ...app, sent };
}

test("completed transcripts enter reconnect context once; interrupted answers do not", async () => {
  const app = fixture(); app.state.modelAudioReceivedInTurn = true;
  await app.parseServerMessage({ serverContent: { inputTranscription: { text: "Мой проект Север", finished: true } } });
  await app.parseServerMessage({ serverContent: { outputTranscription: { text: "Обсудим запуск", finished: true }, turnComplete: true } });
  assert.equal(app.conversationContext.snapshot().length, 2);
  assert.equal(app.state.turnUserText, "");
  await app.parseServerMessage({ serverContent: { inputTranscription: { text: "Другой вопрос" }, outputTranscription: { text: "Недоговорённый ответ" } } });
  await app.parseServerMessage({ serverContent: { interrupted: true } });
  const turns = app.conversationContext.snapshot();
  assert.equal(turns.length, 3);
  assert.equal(turns.at(-1).text, "Другой вопрос");
  assert.ok(!turns.some((turn) => turn.text === "Недоговорённый ответ"));
});

test("cancelled slow tools cannot attach stale sources or send a response", async () => {
  let release;
  const app = fixture(() => new Promise((resolve) => { release = resolve; }));
  const pending = app.handleToolCall({ functionCalls: [{ id: "search", name: "search_web", args: { query: "test" } }] });
  await app.parseServerMessage({ toolCallCancellation: { ids: ["search"] }, serverContent: { interrupted: true } });
  release({ ok: true, json: async () => ({ available: true, sources: [{ url: "https://example.com", title: "Test" }] }) });
  await pending;
  assert.equal(app.sent.length, 0);
  assert.equal(app.state.pendingSources.length, 0);
});

test("actual session setup respects disabled memory and contains companion tools", () => {
  const app = fixture(); app.memoryStore.save({ text: "Синтетический секретный факт" });
  assert.ok(app.getSetupMessage().setup.systemInstruction.parts[0].text.includes("Синтетический секретный факт"));
  app.memoryStore.setEnabled(false);
  assert.ok(!app.getSetupMessage().setup.systemInstruction.parts[0].text.includes("Синтетический секретный факт"));
  const names = app.getSetupMessage().setup.tools[0].functionDeclarations.map((tool) => tool.name);
  for (const name of ["remember_fact", "forget_fact", "read_memory", "search_web"]) assert.ok(names.includes(name));
});

test("forgetting persists deletion, clears history and forces a fresh model session", async () => {
  const app = fixture(async () => ({ ok: true, json: async () => ({ token: "test-token" }) }));
  const note = app.memoryStore.save({ text: "Проект Север" });
  app.state.turnUserText = "Забудь мой проект";
  app.conversationContext.add("user", "Проект Север");
  app.state.resumptionHandle = "old-session";
  await app.handleToolCall({ functionCalls: [{ id: "forget", name: "forget_fact", args: { id: note.id, source: "Забудь мой проект" } }] });
  assert.equal(app.memoryStore.forSession().length, 0);
  assert.equal(app.state.refreshAfterForget, true);
  app.state.microphone = {};
  app.refreshAfterForgetting();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state.resumptionHandle, null);
  assert.equal(app.state.refreshAfterForget, false);
  assert.equal(app.conversationContext.snapshot().length, 0);
  assert.equal(app.state.sessionToken, "test-token");
});
