import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as persona from "../public/persona.js";
import * as memory from "../public/memory.js";
import { COMPANION_TOOLS } from "../public/companion-tools.js";

function fixture(fetchImpl = async () => ({ ok: true, json: async () => ({}) }), extra = {}) {
  function element() {
    const children = new Map();
    return { dataset: {}, value: "", textContent: "", style: { setProperty() {} },
      append() {}, appendChild() {}, remove() {}, focus() {}, setAttribute() {}, classList: { add() {} },
      querySelector: (selector) => {
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
    };
  }
  const root = element();
  const document = { querySelector: root.querySelector, createElement: element, documentElement: element() };
  document.querySelector("#mode-select").value = "friend";
  document.querySelector("#profanity-select").value = "moderate";
  document.querySelector("#voice-select").value = "Aoede";
  const stored = new Map();
  const window = { localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } } };
  let now = 1000;
  const timers = new Map();
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\s*/gm, "").split('elements.button.addEventListener("click"')[0];
  const sent = [];
  class Socket { static OPEN = 1; constructor() { this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } addEventListener() {} close() {} }
  const ctx = vm.createContext({ ...persona, ...memory, COMPANION_TOOLS, document, window,
    fetch: fetchImpl, WebSocket: Socket, URL, AbortSignal, AbortController,
    setTimeout: (callback, ms) => { timers.set(ms, callback); return ms; },
    clearTimeout: (id) => timers.delete(id), clearInterval() {}, Intl, Date,
    performance: { now: () => now }, btoa, atob, ...extra });
  vm.runInContext(source, ctx);
  const app = vm.runInContext("({ state, conversationContext, memoryStore, parseServerMessage, handleToolCall, refreshAfterForgetting, getSetupMessage, handleMicrophoneAudio, handleAudioChunk, interruptReply, finishPlayback, beginResponseWatchdog, StreamingPlayer, saveConversationSettings, loadConversationSettings, syncConversationSettings, reconnectSession })", ctx);
  app.state.sessionActive = true;
  app.state.websocket = new Socket();
  app.state.playback = { clear() {}, completeTurn() {} };
  return { ...app, sent, document, stored, timers, advance: (ms) => { now += ms; } };
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

test("speaker echo never clears playback and protected microphone sends no audio", () => {
  const app = fixture(); let clears = 0;
  app.state.connected = true; app.state.replyPlaying = true;
  app.state.playback.clear = () => { clears++; };
  for (let i = 0; i < 30; i++) { app.advance(40); app.handleMicrophoneAudio(new Float32Array(640).fill(.3), .3); }
  assert.equal(clears, 0);
  assert.equal(app.sent.filter((message) => message.realtimeInput?.audio).length, 0);
  assert.equal(app.sent.filter((message) => message.realtimeInput?.audioStreamEnd).length, 1);
  app.finishPlayback(); app.advance(101);
  app.handleMicrophoneAudio(new Float32Array(640), 0);
  assert.equal(app.sent.filter((message) => message.realtimeInput?.audio).length, 1);
});

test("local end of speech finalizes the turn after sending the last audio chunk", () => {
  const app = fixture(); app.state.connected = true;
  app.handleMicrophoneAudio(new Float32Array(640).fill(.05), .05);
  app.advance(40);
  app.handleMicrophoneAudio(new Float32Array(640).fill(.05), .05);
  app.advance(40);
  app.handleMicrophoneAudio(new Float32Array(640), 0);
  app.advance(520);
  app.handleMicrophoneAudio(new Float32Array(640), 0);

  const audioIndex = app.sent.findLastIndex((message) => message.realtimeInput?.audio);
  const endIndex = app.sent.findLastIndex((message) => message.realtimeInput?.audioStreamEnd);
  assert.equal(app.sent.filter((message) => message.realtimeInput?.audioStreamEnd).length, 1);
  assert.ok(endIndex > audioIndex);
  assert.equal(app.document.querySelector("#status").dataset.state, "connecting");
  assert.equal(app.document.querySelector("#status-text").textContent, "Думаю");
});

test("server VAD remains a conservative fallback for local speech detection", () => {
  const app = fixture();
  const vad = app.getSetupMessage().setup.realtimeInputConfig.automaticActivityDetection;
  assert.equal(vad.disabled, false);
  assert.equal(vad.prefixPaddingMs, 100);
  assert.equal(vad.silenceDurationMs, 650);
});

test("opt-in voice interruption leaves RMS spikes to server VAD", async () => {
  const app = fixture(); let clears = 0;
  app.document.querySelector("#voice-interrupt").checked = true;
  app.state.connected = true; app.state.replyPlaying = true;
  app.state.playback.clear = () => { clears++; };
  for (let i = 0; i < 10; i++) app.handleMicrophoneAudio(new Float32Array(640).fill(.2), .2);
  assert.equal(clears, 0); assert.equal(app.sent.length, 10);
  await app.parseServerMessage({ serverContent: { interrupted: true } });
  assert.equal(clears, 1);
});

test("watchdog reports a delay without submitting a new user turn", () => {
  const app = fixture(); app.state.connected = true;
  app.beginResponseWatchdog();
  app.timers.get(10000)(); app.timers.get(30000)();
  assert.equal(app.sent.length, 0);
});

test("manual stop rejects late audio even after 1.5 seconds", async () => {
  const app = fixture(); let pushes = 0;
  app.state.replyPlaying = true;
  app.state.playback.push = async () => { pushes++; };
  app.interruptReply(); app.advance(5000);
  app.handleAudioChunk("AAAA", "audio/pcm;rate=24000");
  assert.equal(pushes, 0);
  await app.parseServerMessage({ serverContent: { outputTranscription: { text: "Старый хвост" }, turnComplete: true } });
  assert.equal(app.state.replyPlaying, false);
  assert.ok(!app.conversationContext.snapshot().some((turn) => turn.text === "Старый хвост"));
});

test("conversation settings survive reload without overwriting memory", () => {
  const app = fixture(); const controls = app.document.querySelector;
  app.memoryStore.save({ text: "Тестовый факт" });
  controls("#mode-select").value = "plan"; controls("#profanity-select").value = "always";
  controls("#voice-select").value = "Aoede";
  controls("#voice-interrupt").checked = false;
  app.saveConversationSettings();
  controls("#mode-select").value = "friend"; controls("#profanity-select").value = "free";
  app.loadConversationSettings(); app.memoryStore.load();
  assert.equal(controls("#mode-select").value, "plan");
  assert.equal(controls("#profanity-select").value, "always");
  assert.equal(controls("#voice-select").value, "Aoede");
  assert.equal(app.memoryStore.forSession()[0].text, "Тестовый факт");
});

test("text without model audio never switches to a browser voice", async () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /speechSynthesis|SpeechSynthesisUtterance/);
  const app = fixture();
  await app.parseServerMessage({ serverContent: {
    outputTranscription: { text: "Ответ только текстом", finished: true },
    turnComplete: true,
  } });
  assert.equal(app.state.replyPlaying, false);
  assert.match(app.document.querySelector("#error-message").textContent, /другой голос не включён/i);
});

test("v3 migration restores explicit once while preserving voice, interruption and memory", () => {
  const app = fixture(); const controls = app.document.querySelector;
  app.memoryStore.save({ text: "Тестовый факт" });
  app.stored.set("manyasha.conversation.v3", JSON.stringify({ mode: "friend", profanity: "moderate", voice: "Kore", voiceInterrupt: true }));
  app.loadConversationSettings(); app.syncConversationSettings(); app.saveConversationSettings();
  assert.equal(controls("#mode-select").value, "explicit");
  assert.equal(controls("#profanity-select").value, "always");
  assert.equal(controls("#voice-select").value, "Kore");
  assert.equal(controls("#voice-interrupt").checked, true);
  assert.match(app.getSetupMessage().setup.systemInstruction.parts[0].text, /Режим: «Матерный друг»/);
  controls("#mode-select").value = "listen";
  app.syncConversationSettings({ modeChanged: true }); app.saveConversationSettings();
  controls("#mode-select").value = "explicit";
  app.loadConversationSettings(); app.memoryStore.load();
  assert.equal(controls("#mode-select").value, "listen");
  assert.equal(controls("#profanity-select").value, "off");
  assert.equal(app.memoryStore.forSession()[0].text, "Тестовый факт");
});

test("restored mode locks profanity only until switching to a regular mode", () => {
  const app = fixture(); app.state.sessionActive = false;
  const controls = app.document.querySelector;
  app.loadConversationSettings(); app.syncConversationSettings();
  assert.equal(controls("#mode-select").value, "explicit");
  assert.equal(controls("#profanity-select").disabled, true);
  controls("#mode-select").value = "friend";
  app.syncConversationSettings({ modeChanged: true });
  assert.equal(controls("#profanity-select").value, "moderate");
  assert.equal(controls("#profanity-select").disabled, false);
});

test("stopping an already generated answer does not swallow the next answer", () => {
  const app = fixture(); let pushes = 0;
  app.state.replyPlaying = true; app.state.generationComplete = true;
  app.state.playback.push = async () => { pushes++; };
  app.interruptReply();
  assert.equal(app.state.locallyInterrupted, false);
  app.handleAudioChunk("AAAA", "audio/pcm;rate=24000");
  assert.equal(pushes, 1);
  assert.equal(app.state.replyPlaying, true);
});

test("fresh reconnect seals received audio so missing old completion cannot lock the mic", async () => {
  const app = fixture(async () => ({ ok: true, json: async () => ({ token: "new-token" }) }));
  let completed = 0;
  app.state.microphone = {};
  app.state.replyPlaying = true; app.state.modelAudioReceivedInTurn = true;
  app.state.playback.completeTurn = async () => { completed++; };
  await app.reconnectSession({ forceFresh: true });
  assert.equal(completed, 1); assert.equal(app.state.pendingTurnComplete, true);
  app.finishPlayback(); assert.equal(app.state.replyPlaying, false);
});

test("player orders final PCM before completion even while AudioContext resumes", async () => {
  const messages = []; let resume;
  class AudioContext {
    constructor() { this.state = "suspended"; this.sampleRate = 24000; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return new Promise((resolve) => { resume = () => { this.state = "running"; resolve(); }; }); }
  }
  class AudioWorkletNode { constructor() { this.port = { postMessage: (value) => messages.push(value) }; } connect() {} }
  const { StreamingPlayer } = fixture(undefined, { AudioContext, AudioWorkletNode });
  const player = new StreamingPlayer(() => {}, () => {});
  const push = player.push("AAAA", 24000);
  const complete = player.completeTurn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!messages.some((message) => message.type === "turn-complete"));
  resume(); await Promise.all([push, complete]);
  assert.deepEqual(messages.map((message) => message.type), ["clear", "push", "turn-complete"]);
});

test("clear invalidates PCM waiting for audio context resume", async () => {
  const messages = []; let resume;
  class AudioContext {
    constructor() { this.state = "suspended"; this.sampleRate = 24000; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return new Promise((resolve) => { resume = () => { this.state = "running"; resolve(); }; }); }
  }
  class AudioWorkletNode { constructor() { this.port = { postMessage: (value) => messages.push(value) }; } connect() {} }
  const { StreamingPlayer } = fixture(undefined, { AudioContext, AudioWorkletNode });
  const player = new StreamingPlayer(() => {}, () => {});
  const push = player.push("AAAA", 24000);
  await new Promise((resolve) => setImmediate(resolve));
  player.clear(); resume(); await push;
  assert.ok(!messages.some((message) => message.type === "push"));
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
