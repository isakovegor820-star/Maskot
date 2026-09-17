import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, ConversationContext, runMemoryTool, MEMORY_KEY, MEMORY_LIMIT } from "../public/memory.js";
import { buildSystemInstruction } from "../public/persona.js";

function fixture() {
  const data = new Map(); let number = 0;
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  return { data, storage, store: new MemoryStore(storage, { id: () => `note-${++number}` }) };
}
test("memory survives a new session, updates one fact, and forgets durably", () => {
  const { store, storage } = fixture();
  const note = store.save({ text: "Проект Север: запуск 25 сентября", kind: "project" });
  const reopened = new MemoryStore(storage);
  assert.equal(reopened.forSession()[0].text, note.text);
  reopened.save({ id: note.id, text: "Проект Север: запуск 28 сентября", kind: "project" });
  assert.equal(reopened.forSession().length, 1);
  assert.match(reopened.forSession()[0].text, /28 сентября/);
  reopened.remove(note.id);
  assert.equal(new MemoryStore(storage).forSession().length, 0);
});
test("disabled memory is retained locally but omitted from prompt and tools", () => {
  const { store } = fixture(); store.save({ text: "Имя: Тестовый собеседник" }); store.setEnabled(false);
  assert.equal(store.snapshot().notes.length, 1);
  assert.deepEqual(store.forSession(), []);
  const prompt = buildSystemInstruction({ memory: store.snapshot() });
  assert.ok(!prompt.includes("Тестовый собеседник"));
  assert.ok(runMemoryTool(store, { name: "remember_fact", args: { text: "Новое", source: "Новое" } }, ["Новое"]).error);
});
test("failed persistence does not report success or mutate in-memory facts", () => {
  const { store, storage } = fixture();
  storage.setItem = () => { throw new Error("QuotaExceeded"); };
  const result = runMemoryTool(store, { name: "remember_fact", args: { text: "Люблю короткие советы", kind: "preference", source: "Люблю короткие советы" } }, ["Люблю короткие советы"]);
  assert.ok(result.error); assert.equal(result.saved, undefined); assert.deepEqual(store.forSession(), []);
});
test("model cannot save unsupported memories or delete without a user request", () => {
  const { store } = fixture();
  const call = { name: "remember_fact", args: { text: "Собеседник живёт в Париже", kind: "profile", source: "живу в Париже" } };
  assert.ok(runMemoryTool(store, call, ["Хочу поехать в Париж"]).error);
  assert.equal(store.forSession().length, 0);
  const saved = runMemoryTool(store, { ...call, args: { ...call.args, source: "Я живу в Париже" } }, ["Запомни: я живу в Париже."]);
  assert.equal(saved.saved, true);
  const id = saved.note.id;
  assert.ok(runMemoryTool(store, { name: "forget_fact", args: { id, source: "Я живу в Париже" } }, ["Я живу в Париже"]).error);
  assert.equal(runMemoryTool(store, { name: "forget_fact", args: { id, source: "Забудь мой город" } }, ["Забудь мой город"]).forgotten, true);
});
test("corrupt data does not crash or get silently overwritten", () => {
  const { data, storage } = fixture(); data.set(MEMORY_KEY, "broken");
  const store = new MemoryStore(storage);
  assert.ok(store.error); assert.equal(store.state.enabled, false); assert.equal(data.get(MEMORY_KEY), "broken");
  data.delete(MEMORY_KEY); store.load(); assert.equal(store.error, "");
});
test("memory bounds prevent silent eviction and duplicate notes", () => {
  const { store } = fixture();
  for (let i = 0; i < MEMORY_LIMIT; i++) store.save({ text: `Факт ${i}` });
  store.save({ text: "Факт 0" }); assert.equal(store.forSession().length, MEMORY_LIMIT);
  assert.throws(() => store.save({ text: "Переполнение" }), /40/);
  assert.equal(store.forSession()[0].text, "Факт 0");
});
test("conversation context is bounded and user provenance excludes assistant statements", () => {
  const history = new ConversationContext();
  for (let i = 0; i < 40; i++) history.add(i % 2 ? "model" : "user", `Реплика ${i}`);
  assert.equal(history.snapshot().length, 24);
  assert.deepEqual(history.userTexts(), ["Реплика 34", "Реплика 36", "Реплика 38"]);
  history.clear(); assert.deepEqual(history.snapshot(), []);
});
