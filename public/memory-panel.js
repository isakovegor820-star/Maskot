import { MEMORY_KIND_LABELS, MEMORY_LIMIT } from "./memory.js";

export function createMemoryPanel(store, onManualChange) {
  const get = (id) => document.getElementById(id);
  const form = get("memory-form"), list = get("memory-list"), input = get("memory-text");
  const kind = get("memory-kind"), enabled = get("memory-enabled"), status = get("memory-status");
  const error = get("memory-error"), cancel = get("memory-cancel"), save = get("memory-save");
  let editingId = null, undoNote = null;

  function announce(message) { status.textContent = message; }
  function resetForm() {
    editingId = null; input.value = ""; kind.value = "profile";
    cancel.hidden = true; save.textContent = "Добавить заметку";
    input.removeAttribute("aria-invalid");
  }
  function action(callback) {
    error.hidden = true; error.textContent = "";
    try { callback(); render(); }
    catch (failure) { error.textContent = failure.message; error.hidden = false; }
  }
  function button(label, callback) {
    const element = document.createElement("button");
    element.type = "button"; element.className = "quiet-button";
    element.textContent = label; element.addEventListener("click", callback);
    return element;
  }
  function render() {
    const notes = store.snapshot().notes;
    enabled.checked = store.state.enabled;
    get("memory-disabled-note").hidden = store.state.enabled;
    get("memory-count").textContent = `${notes.length} / ${MEMORY_LIMIT}`;
    get("memory-empty").hidden = notes.length > 0;
    get("memory-editor").disabled = !store.state.enabled;
    list.replaceChildren();
    for (const note of notes) {
      const row = document.createElement("li");
      const meta = document.createElement("span"); meta.className = "memory-kind";
      meta.textContent = MEMORY_KIND_LABELS[note.kind];
      const text = document.createElement("p"); text.textContent = note.text;
      const actions = document.createElement("div"); actions.className = "memory-actions";
      const edit = button("Изменить", () => {
        editingId = note.id; input.value = note.text; kind.value = note.kind;
        cancel.hidden = false; save.textContent = "Сохранить изменения"; input.focus();
      });
      edit.disabled = !store.state.enabled;
      edit.setAttribute("aria-label", `Изменить заметку: ${note.text}`);
      const remove = button("Удалить", () => action(() => {
        store.remove(note.id); undoNote = note;
        if (editingId === note.id) resetForm();
        get("memory-undo").hidden = false;
        onManualChange(); announce("Заметка удалена. Можно отменить удаление.");
        get("memory-undo").focus();
      }));
      remove.setAttribute("aria-label", `Удалить заметку: ${note.text}`);
      actions.append(edit, remove); row.append(meta, text, actions); list.append(row);
    }
    get("memory-clear").disabled = notes.length === 0;
    if (store.error) { error.textContent = store.error; error.hidden = false; }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input.value.trim()) {
      input.setAttribute("aria-invalid", "true"); error.textContent = "Напишите, что Маняше важно запомнить.";
      error.hidden = false; input.focus(); return;
    }
    action(() => {
      store.save({ id: editingId, text: input.value, kind: kind.value });
      onManualChange(); resetForm(); announce("Заметка сохранена для следующего разговора."); input.focus();
    });
  });
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit();
  });
  cancel.addEventListener("click", () => { resetForm(); input.focus(); });
  enabled.addEventListener("change", () => action(() => {
    const previous = store.state.enabled;
    try { store.setEnabled(enabled.checked); } catch (failure) { enabled.checked = previous; throw failure; }
    onManualChange();
    announce(store.state.enabled ? "Память включена." : "Память выключена. Заметки сохранены, но Маняша их не использует.");
  }));
  get("memory-undo").addEventListener("click", () => action(() => {
    if (!undoNote) return;
    store.save({ ...undoNote, id: undefined }); undoNote = null;
    get("memory-undo").hidden = true; onManualChange(); announce("Заметка восстановлена."); input.focus();
  }));
  get("memory-clear").addEventListener("click", () => {
    get("memory-confirm").hidden = false; get("memory-keep").focus();
  });
  get("memory-keep").addEventListener("click", () => {
    get("memory-confirm").hidden = true; get("memory-clear").focus();
  });
  get("memory-confirm-delete").addEventListener("click", () => action(() => {
    store.clear(); undoNote = null; get("memory-undo").hidden = true;
    get("memory-confirm").hidden = true; resetForm(); onManualChange();
    announce("Все заметки удалены. Контекст прошлого разговора сброшен."); enabled.focus();
  }));
  render();
  return {
    render, announce,
    setActive(active) {
      get("memory-controls").disabled = active;
      get("memory-session-note").hidden = !active;
    },
  };
}
