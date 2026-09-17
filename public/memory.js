export const MEMORY_KEY = "manyasha.memory.v1";
export const MEMORY_LIMIT = 40;
export const NOTE_LIMIT = 400;
const kinds = new Set(["profile", "preference", "project", "goal", "event"]);
export const MEMORY_KIND_LABELS = {
  profile: "О тебе", preference: "Как тебе удобнее", project: "Проект", goal: "Цель", event: "Важное событие",
};

function cleanText(value, limit = NOTE_LIMIT) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
    throw new Error(`Напишите заметку от 1 до ${limit} символов.`);
  }
  return value.trim();
}

export class MemoryStore {
  constructor(storage, { now = () => new Date().toISOString(), id = () => crypto.randomUUID() } = {}) {
    this.storage = storage;
    this.now = now;
    this.id = id;
    this.state = { version: 1, enabled: true, notes: [] };
    this.error = "";
    this.load();
  }

  load() {
    try {
      const raw = this.storage.getItem(MEMORY_KEY);
      if (!raw) { this.state = { version: 1, enabled: true, notes: [] }; this.error = ""; return; }
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.notes)) throw new Error("Invalid memory");
      const notes = data.notes.slice(0, MEMORY_LIMIT).map((note) => ({
        id: cleanText(note.id, 100), text: cleanText(note.text),
        kind: kinds.has(note.kind) ? note.kind : "profile",
        source: typeof note.source === "string" ? note.source.slice(0, NOTE_LIMIT) : "",
        updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : "",
      }));
      this.state = { version: 1, enabled: data.enabled !== false, notes };
      this.error = "";
    } catch {
      this.state = { version: 1, enabled: false, notes: [] };
      this.error = "Не удалось прочитать память. Разговор доступен без сохранения заметок.";
    }
  }

  commit(next) {
    // Never claim a successful save unless durable storage accepted it.
    try { this.storage.setItem(MEMORY_KEY, JSON.stringify(next)); }
    catch { throw new Error("Браузер не сохранил заметку. Проверьте доступ к хранилищу сайта."); }
    this.state = next;
    this.error = "";
  }

  snapshot() { return structuredClone(this.state); }
  forSession() { return this.state.enabled ? this.snapshot().notes : []; }
  setEnabled(enabled) { this.commit({ ...this.state, enabled: Boolean(enabled) }); }

  save({ id, text, kind = "profile", source = "Добавлено вручную" }) {
    if (!this.state.enabled) throw new Error("Память выключена. Заметка не сохранена.");
    const value = cleanText(text);
    if (!kinds.has(kind)) throw new Error("Выберите тип заметки.");
    const notes = this.snapshot().notes;
    const index = id ? notes.findIndex((note) => note.id === id) : -1;
    if (id && index < 0) throw new Error("Заметка уже удалена. Обновите список.");
    const duplicate = notes.find((note) => note.text.toLocaleLowerCase("ru") === value.toLocaleLowerCase("ru"));
    if (!id && duplicate) return duplicate;
    if (index < 0 && notes.length >= MEMORY_LIMIT) throw new Error("В памяти уже 40 заметок. Удалите ненужную или обновите существующую.");
    const note = { id: id || this.id(), text: value, kind, source: cleanText(source), updatedAt: this.now() };
    if (index < 0) notes.push(note); else notes[index] = note;
    this.commit({ ...this.state, notes });
    return note;
  }

  remove(id) {
    if (!this.state.notes.some((note) => note.id === id)) throw new Error("Заметка не найдена.");
    this.commit({ ...this.state, notes: this.state.notes.filter((note) => note.id !== id) });
  }
  clear() { this.commit({ ...this.state, notes: [] }); }
}

const normalized = (text) => String(text).toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function verifySource(source, userTexts) {
  const quote = normalized(source);
  return quote.length >= 5 && userTexts.some((text) => normalized(text).includes(quote));
}

export function runMemoryTool(store, call, userTexts) {
  try {
    const args = call.args ?? {};
    if (call.name === "read_memory") return { enabled: store.state.enabled, notes: store.forSession() };
    if (!store.state.enabled) throw new Error("Память выключена.");
    if (!verifySource(args.source, userTexts)) {
      throw new Error("Нет подтверждения в недавних словах собеседника. Не говори, что память изменена. При необходимости уточни факт.");
    }
    if (call.name === "remember_fact") {
      const note = store.save(args);
      return { saved: true, note };
    }
    if (call.name === "forget_fact") {
      if (!/забуд|удал|не\s+хран|не\s+запомина/iu.test(args.source)) {
        throw new Error("Удаляй заметку только по прямой просьбе собеседника забыть её.");
      }
      store.remove(args.id);
      return { forgotten: true, id: args.id };
    }
    throw new Error("Неизвестный инструмент памяти.");
  } catch (error) { return { error: error.message }; }
}

export class ConversationContext {
  constructor() { this.turns = []; }
  add(role, text) {
    if (!text?.trim()) return;
    this.turns.push({ role, text: text.trim().slice(0, 2000) });
    this.turns = this.turns.slice(-24);
  }
  clear() { this.turns = []; }
  snapshot() { return this.turns.map((turn) => ({ ...turn })); }
  userTexts() { return this.turns.filter((turn) => turn.role === "user").slice(-3).map((turn) => turn.text); }
}
