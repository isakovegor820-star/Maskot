import {
  MODE_DEFINITIONS,
  buildSystemInstruction,
  resolveConversationConfig,
} from "/persona.js?v=0.5.0";
import { MEMORY_KEY, MemoryStore, ConversationContext, runMemoryTool } from "./memory.js";
import { createMemoryPanel } from "./memory-panel.js";
import { COMPANION_TOOLS } from "./companion-tools.js";

const memoryStore = new MemoryStore({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
});
const conversationContext = new ConversationContext();
let memoryPanel = null;

const MODEL = "gemini-3.1-flash-live-preview";
const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

const elements = {
  activeSettings: document.querySelector("#active-settings"),
  button: document.querySelector("#conversation-button"),
  buttonLabel: document.querySelector("#button-label"),
  interrupt: document.querySelector("#interrupt-button"),
  voiceInterrupt: document.querySelector("#voice-interrupt"),
  connection: document.querySelector("#connection-value"),
  emptyTranscript: document.querySelector("#empty-transcript"),
  error: document.querySelector("#error-message"),
  latency: document.querySelector("#latency-value"),
  mascot: document.querySelector("#mascot"),
  mode: document.querySelector("#mode-select"),
  modeHelp: document.querySelector("#mode-help"),
  profanity: document.querySelector("#profanity-select"),
  profanityHelp: document.querySelector("#profanity-help"),
  sessionTime: document.querySelector("#session-time"),
  settings: document.querySelector(".settings"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  transcript: document.querySelector("#transcript"),
  voice: document.querySelector("#voice-select"),
};

const state = {
  awaitingResponse: false,
  connectAbortController: null,
  connected: false,
  connecting: false,
  interactionId: 0,
  interruptionStartedAt: null,
  lastLocalSpeechAt: null,
  localSpeechActive: false,
  localSpeechFrames: 0,
  localSilenceStartedAt: null,
  locallyInterrupted: false,
  lastSpeechEndedAt: null,
  latencyCapturedForTurn: false,
  microphone: null,
  modelAudioReceivedInTurn: false,
  outputMessage: null,
  outputText: "",
  pendingTurnComplete: false,
  playback: null,
  reconnectAttempts: 0,
  reconnecting: false,
  responseWatchdog: null,
  responseWatchdogFinal: null,
  resumptionHandle: null,
  sessionActive: false,
  sessionToken: null,
  sessionStartedAt: null,
  sessionTimer: null,
  turnOutputText: "",
  turnUserText: "",
  pendingSources: [],
  lastModelMessage: null,
  toolGeneration: 0,
  refreshAfterForget: false,
  replyPlaying: false,
  micResumeAt: 0,
  micPaused: false,
  generationComplete: false,
  userMessage: null,
  userText: "",
  websocket: null,
};

function setUiState(nextState, text) {
  elements.status.dataset.state = nextState;
  elements.statusText.textContent = text;
  elements.mascot.dataset.state = nextState;
  elements.interrupt.disabled = !state.sessionActive || !state.replyPlaying;
  elements.connection.textContent =
    nextState === "listening" || nextState === "speaking"
      ? "Стабильно"
      : nextState === "connecting"
        ? "Подключаем"
        : nextState === "error"
          ? "Ошибка"
          : "Неактивно";
}

function setConversationControls(active) {
  elements.button.disabled = false;
  elements.button.setAttribute("aria-pressed", String(active));
  elements.button.setAttribute("aria-busy", String(active && state.connecting));
  elements.buttonLabel.textContent = active ? "Завершить разговор" : "Начать разговор";
  elements.voice.disabled = active;
  elements.mode.disabled = active;
  elements.voiceInterrupt.disabled = active;
  const modeLocksProfanity = Boolean(MODE_DEFINITIONS[elements.mode.value]?.profanity);
  elements.profanity.disabled = active || modeLocksProfanity;
  if (active) elements.settings.open = false;
  memoryPanel?.setActive(active);
}

function syncConversationSettings({ modeChanged = false } = {}) {
  const modeDefinition = MODE_DEFINITIONS[elements.mode.value] ?? MODE_DEFINITIONS.friend;
  if (modeDefinition.profanity) {
    elements.profanity.value = modeDefinition.profanity;
  } else if (modeChanged) {
    elements.profanity.value = modeDefinition.defaultProfanity ?? "moderate";
  }

  const config = resolveConversationConfig(elements.mode.value, elements.profanity.value);
  elements.modeHelp.textContent = config.modeDefinition.help;
  elements.profanityHelp.textContent = config.profanityDefinition.help;
  elements.activeSettings.textContent = `Режим: ${config.modeDefinition.label}. Мат: ${config.profanityDefinition.label.toLocaleLowerCase("ru")}. Голос: ${elements.voice.value}. ${elements.voiceInterrupt.checked ? "Можно перебивать голосом — лучше в наушниках." : "Защита от обрывов включена — перебивание кнопкой."}`;
  setConversationControls(state.sessionActive);
}

function clearResponseWatchdog() {
  clearTimeout(state.responseWatchdog);
  clearTimeout(state.responseWatchdogFinal);
  state.responseWatchdog = null;
  state.responseWatchdogFinal = null;
  state.awaitingResponse = false;
}

function beginResponseWatchdog() {
  clearResponseWatchdog();
  state.awaitingResponse = true;

  state.responseWatchdog = setTimeout(() => {
    if (!state.sessionActive || !state.connected || !state.awaitingResponse) return;
    // Never inject a new user turn: turnComplete:true cancels live generation.
    setUiState("connecting", "Ответ готовится — жду Маняшу");
  }, 10_000);

  state.responseWatchdogFinal = setTimeout(() => {
    if (!state.sessionActive || !state.awaitingResponse) return;
    clearResponseWatchdog();
    state.locallyInterrupted = false;
    setUiState("listening", "Не расслышала — повторите фразу");
  }, 30_000);
}

function getSystemInstruction() {
  return buildSystemInstruction({
    mode: elements.mode.value,
    profanity: elements.profanity.value,
    memory: memoryStore.snapshot(),
    conversation: conversationContext.snapshot(),
  });
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
  setUiState("error", "Нужно проверить подключение");
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}

function base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

function float32ToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return pcm.buffer;
}

function send(message) {
  if (state.websocket?.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify(message));
  }
}

class MicrophoneStream {
  constructor(onAudio) {
    this.onAudio = onAudio;
    this.context = null;
    this.node = null;
    this.source = null;
    this.stream = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
      },
    });

    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("/capture.worklet.js?v=0.1.2");
    this.node = new AudioWorkletNode(this.context, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node.port.onmessage = (event) => {
      if (event.data?.type === "audio") this.onAudio(event.data.samples, event.data.rms);
    };
    this.source.connect(this.node);
    await this.context.resume();
  }

  async stop() {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}

class StreamingPlayer {
  constructor(onLevel, onDrained) {
    this.onLevel = onLevel;
    this.onDrained = onDrained;
    this.context = null;
    this.node = null;
    this.pending = Promise.resolve();
    this.generation = 0;
    this.initPromise = null;
  }

  init() {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  async initialize() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("/playback.worklet.js?v=0.3.0");
    this.node = new AudioWorkletNode(this.context, "playback-processor", {
      outputChannelCount: [1],
    });
    this.node.port.postMessage({ type: "clear", generation: this.generation });
    this.node.port.onmessage = (event) => {
      if (event.data?.type === "level") this.onLevel(event.data.value);
      if (event.data?.type === "drained" && event.data.generation === this.generation) this.onDrained();
    };
    this.node.connect(this.context.destination);
    await this.context.resume();
  }

  enqueue(operation) {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  push(base64Audio, sourceRate = 24000) {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      await this.init();
      if (this.context.state === "suspended") await this.context.resume();
      if (generation !== this.generation) return;
      const decoded = base64ToFloat32(base64Audio);
      const samples = resampleLinear(decoded, sourceRate, this.context.sampleRate);
      this.node.port.postMessage({ type: "push", samples, generation }, [samples.buffer]);
    });
  }

  clear() {
    this.generation += 1;
    this.node?.port.postMessage({ type: "clear", generation: this.generation });
    document.documentElement.style.setProperty("--orb-level", "0");
  }

  completeTurn() {
    const generation = this.generation;
    return this.enqueue(() => {
      if (generation === this.generation) this.node?.port.postMessage({ type: "turn-complete", generation });
    });
  }

  async destroy() {
    this.clear();
    await this.pending;
    if (this.initPromise) await this.initPromise.catch(() => {});
    this.node?.disconnect();
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.node = null;
    this.context = null;
  }
}

function resampleLinear(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate || samples.length < 2) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const scale = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = Math.min(samples.length - 1, index * scale);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    output[index] = samples[leftIndex] + (samples[rightIndex] - samples[leftIndex]) * fraction;
  }
  return output;
}

function handleLocalVoiceActivity(rms) {
  const speakingThreshold = 0.009;
  const endSilenceMs = 620;
  const now = performance.now();

  if (rms >= speakingThreshold) {
    state.localSpeechFrames += 1;
    state.localSilenceStartedAt = null;
    if (state.localSpeechFrames >= 2) {
      if (!state.localSpeechActive) clearResponseWatchdog();
      state.localSpeechActive = true;
      state.lastLocalSpeechAt = now;
      // RMS is not speech recognition. Only a server interruption or the button
      // may discard an answer; a fan/click/echo must never clear playback here.
      state.latencyCapturedForTurn = false;
    }
    return;
  }

  if (state.localSpeechFrames < 2) {
    state.localSpeechFrames = 0;
    return;
  }
  if (state.localSilenceStartedAt === null) state.localSilenceStartedAt = now;
  if (now - state.localSilenceStartedAt >= endSilenceMs) {
    state.localSpeechFrames = 0;
    state.localSilenceStartedAt = null;
    state.localSpeechActive = false;
    state.lastSpeechEndedAt = performance.now();
    state.latencyCapturedForTurn = false;
    if (!state.replyPlaying) {
      setUiState("connecting", "Формулирую ответ");
      beginResponseWatchdog();
    }
  }
}

function handleMicrophoneAudio(samples, rms) {
  if (!state.connected) return;
  if ((!elements.voiceInterrupt.checked && state.replyPlaying) || performance.now() < state.micResumeAt) {
    if (!state.micPaused) {
      state.micPaused = true;
      send({ realtimeInput: { audioStreamEnd: true } });
    }
    return;
  }
  state.micPaused = false;
  handleLocalVoiceActivity(rms);
  send({
    realtimeInput: {
      audio: {
        data: bytesToBase64(float32ToPcm16(samples)),
        mimeType: "audio/pcm;rate=16000",
      },
    },
  });
}

function resetLocalSpeech() {
  state.localSpeechFrames = 0;
  state.localSpeechActive = false;
  state.localSilenceStartedAt = null;
}

function markReplyPlaying() {
  state.replyPlaying = true;
  elements.interrupt.disabled = !state.sessionActive;
  resetLocalSpeech();
}

function finishPlayback() {
  state.replyPlaying = false;
  state.modelAudioReceivedInTurn = false;
  state.pendingTurnComplete = false;
  state.turnOutputText = "";
  state.micResumeAt = performance.now() + 300;
  resetLocalSpeech();
  if (state.sessionActive) setUiState(state.connected ? "listening" : "connecting", state.connected ? "Слушаю вас" : "Восстанавливаю разговор");
}

function interruptReply() {
  if (!state.sessionActive || !state.replyPlaying) return;
  // If generation already ended, only the local queue is stopped. There will
  // be no server interruption event to release a suppression flag afterwards.
  state.locallyInterrupted = !state.generationComplete;
  state.toolGeneration += 1;
  state.playback?.clear();
  finishPlayback();
  elements.button.focus();
  setUiState("listening", "Ответ остановлен — говорите");
}

function createMessage(speaker) {
  elements.emptyTranscript?.remove();
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.speaker = speaker;
  article.dataset.pending = "true";

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = speaker === "user" ? "Вы" : "Маняша";

  const text = document.createElement("p");
  text.className = "message-text";

  article.append(label, text);
  elements.transcript.append(article);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  return article;
}

function mergeTranscript(previous, incoming) {
  const next = String(incoming ?? "");
  if (!next) return previous;
  if (!previous || next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return `${previous}${next}`;
}

function updateTranscript(speaker, text, finished = false) {
  const messageKey = speaker === "user" ? "userMessage" : "outputMessage";
  const textKey = speaker === "user" ? "userText" : "outputText";

  if (!state[messageKey]) state[messageKey] = createMessage(speaker);
  state[textKey] = mergeTranscript(state[textKey], text);
  if (speaker === "model") state.turnOutputText = state[textKey];
  else state.turnUserText = state[textKey];
  if (speaker === "model") state.lastModelMessage = state[messageKey];
  state[messageKey].querySelector(".message-text").textContent = state[textKey].trim();
  state[messageKey].dataset.pending = String(!finished);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;

  if (finished) {
    state[messageKey] = null;
    state[textKey] = "";
  }
}

function finishContextTurn({ interrupted = false } = {}) {
  conversationContext.add("user", state.turnUserText);
  if (!interrupted) conversationContext.add("model", state.turnOutputText);
  state.turnUserText = "";
  for (const speaker of ["user", "output"]) {
    if (state[`${speaker}Message`]) state[`${speaker}Message`].dataset.pending = "false";
    state[`${speaker}Message`] = null;
    state[`${speaker}Text`] = "";
  }
}

function renderSources() {
  if (!state.pendingSources.length) return;
  const article = state.lastModelMessage ?? createMessage("model");
  for (const result of state.pendingSources) {
    const list = document.createElement("ul"); list.className = "message-sources";
    for (const source of result.sources ?? []) {
      try {
        const url = new URL(source.url);
        if (!["https:", "http:"].includes(url.protocol)) continue;
        const li = document.createElement("li"), a = document.createElement("a");
        a.href = url.href; a.textContent = source.title; a.target = "_blank"; a.rel = "noopener noreferrer";
        li.append(a); list.append(li);
      } catch { /* Ignore malformed source URLs. */ }
    }
    article.append(list);
    if (result.suggestionsHtml) {
      const frame = document.createElement("iframe");
      frame.title = "Поисковые подсказки Google"; frame.className = "search-suggestions";
      frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
      frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><base target="_blank">${result.suggestionsHtml}`;
      article.append(frame);
    }
  }
  state.pendingSources = [];
}

function getAudioSampleRate(mimeType = "") {
  const match = /(?:^|;)\s*rate=(\d+)/i.exec(mimeType);
  const rate = Number(match?.[1]);
  return Number.isFinite(rate) && rate >= 8000 && rate <= 192000 ? rate : 24000;
}

function handleAudioChunk(base64Audio, mimeType) {
  if (state.locallyInterrupted) return;
  state.generationComplete = false;
  clearResponseWatchdog();
  state.modelAudioReceivedInTurn = true;
  markReplyPlaying();
  if (!state.latencyCapturedForTurn && state.lastSpeechEndedAt) {
    const latencyMs = Math.max(0, Math.round(performance.now() - state.lastSpeechEndedAt));
    elements.latency.textContent = `${latencyMs} мс`;
    state.latencyCapturedForTurn = true;
  }
  state.pendingTurnComplete = false;
  setUiState("speaking", elements.voiceInterrupt.checked ? "Отвечаю — можно перебить голосом" : "Отвечаю — можно нажать «Перебить ответ»");
  state.playback.push(base64Audio, getAudioSampleRate(mimeType)).catch(() => {
    finishPlayback();
    showError("Не удалось воспроизвести ответ. Проверьте настройки звука браузера.");
  });
}

async function handleToolCall(toolCall, socket = state.websocket) {
  clearTimeout(state.responseWatchdog);
  clearTimeout(state.responseWatchdogFinal);
  const interactionId = state.interactionId;
  const generation = state.toolGeneration;
  const stillCurrent = () => state.sessionActive && state.interactionId === interactionId && state.websocket === socket && state.toolGeneration === generation;
  const functionResponses = await Promise.all(
    (toolCall.functionCalls ?? []).map(async (call) => {
      if (["read_memory", "remember_fact", "forget_fact"].includes(call.name)) {
        const response = runMemoryTool(memoryStore, call, [
          ...conversationContext.userTexts(), state.turnUserText, state.userText,
        ]);
        memoryPanel?.render();
        if (response.saved) memoryPanel?.announce(`Маняша запомнила: ${response.note.text}`);
        if (response.forgotten) {
          conversationContext.clear();
          state.refreshAfterForget = true;
          memoryPanel?.announce("Маняша удалила заметку из памяти.");
        }
        return { id: call.id, name: call.name, response };
      }
      if (call.name === "search_web") {
        let result;
        try {
          const query = String(call.args?.query ?? "").trim().slice(0, 300);
          const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20000) });
          result = await response.json();
          if (!response.ok) result = { available: false, error: result.error ?? "Веб-поиск недоступен." };
        } catch { result = { available: false, error: "Веб-поиск недоступен. Актуальность не проверена." }; }
        if (result.available && stillCurrent()) state.pendingSources.push(result);
        const { suggestionsHtml, ...response } = result;
        return { id: call.id, name: call.name, response };
      }
      if (call.name === "get_current_datetime") {
        const now = new Date();
        return {
          id: call.id,
          name: call.name,
          response: {
            iso: now.toISOString(),
            local: now.toLocaleString("ru-RU", { dateStyle: "full", timeStyle: "long" }),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
          },
        };
      }

      if (call.name !== "search_product_knowledge") {
        return {
          id: call.id,
          name: call.name,
          response: { error: "Инструмент не поддерживается." },
        };
      }

      try {
        const query = String(call.args?.query ?? "").slice(0, 200);
        const response = await fetch(`/api/knowledge?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000) });
        const body = await response.json().catch(() => ({}));
        return {
          id: call.id,
          name: call.name,
          response: response.ok
            ? { results: body.results ?? [] }
            : { error: body.error ?? "База знаний недоступна." },
        };
      } catch {
        return {
          id: call.id,
          name: call.name,
          response: { error: "База знаний недоступна." },
        };
      }
    }),
  );

  if (functionResponses.length && stillCurrent()) {
    clearTimeout(state.responseWatchdog);
    state.responseWatchdog = null;
    state.responseWatchdogFinal = setTimeout(() => {
      if (!state.sessionActive || !state.awaitingResponse) return;
      clearResponseWatchdog();
      setUiState("listening", "Ответ задержался — повторите вопрос");
    }, 12_000);
    send({ toolResponse: { functionResponses } });
  }
}

function refreshAfterForgetting() {
  if (!state.refreshAfterForget) return;
  state.refreshAfterForget = false;
  conversationContext.clear();
  state.turnUserText = "";
  state.resumptionHandle = null;
  // A fresh model session prevents deleted notes surviving in provider context.
  void reconnectSession({ forceFresh: true });
}

async function parseServerMessage(payload) {
  if (payload.error) {
    throw new Error(payload.error.message || "Gemini вернул ошибку голосовой сессии.");
  }

  if (payload.setupComplete) {
    if (!state.sessionActive) return;
    state.connected = true;
    state.connecting = false;
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    clearError();
    setConversationControls(true);
    setUiState("listening", "Слушаю вас");
    if (!state.sessionStartedAt) startSessionTimer();
    return;
  }

  const resumptionUpdate = payload.sessionResumptionUpdate;
  if (resumptionUpdate?.resumable && resumptionUpdate.newHandle) {
    state.resumptionHandle = resumptionUpdate.newHandle;
  }

  if (payload.goAway) {
    reconnectSession();
    return;
  }

  const content = payload.serverContent;
  if (payload.toolCallCancellation) state.toolGeneration += 1;
  if (content?.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        handleAudioChunk(part.inlineData.data, part.inlineData.mimeType);
      }
    }
  }

  if (content?.inputTranscription) {
    updateTranscript(
      "user",
      content.inputTranscription.text,
      Boolean(content.inputTranscription.finished),
    );
  }

  if (content?.outputTranscription && !state.locallyInterrupted) {
    state.generationComplete = false;
    clearResponseWatchdog();
    markReplyPlaying();
    updateTranscript(
      "model",
      content.outputTranscription.text,
      Boolean(content.outputTranscription.finished),
    );
  }

  if (content?.interrupted) {
    state.toolGeneration += 1;
    finishContextTurn({ interrupted: true });
    state.pendingSources = [];
    clearResponseWatchdog();
    state.locallyInterrupted = false;
    state.interruptionStartedAt = null;
    state.playback.clear();
    finishPlayback();
    state.modelAudioReceivedInTurn = false;
    state.pendingTurnComplete = false;
    state.turnOutputText = "";
    if (state.outputMessage) {
      state.outputMessage.dataset.pending = "false";
      state.outputMessage = null;
      state.outputText = "";
    }
    setUiState("listening", "Слушаю вас");
    refreshAfterForgetting();
  }

  if (content?.turnComplete) {
    state.generationComplete = true;
    const wasInterrupted = state.locallyInterrupted;
    finishContextTurn({ interrupted: wasInterrupted });
    renderSources();
    clearResponseWatchdog();
    state.locallyInterrupted = false;
    state.interruptionStartedAt = null;
    state.pendingTurnComplete = !wasInterrupted && state.modelAudioReceivedInTurn;
    if (state.pendingTurnComplete) state.playback?.completeTurn()?.catch(() => {
      finishPlayback(); showError("Не удалось завершить озвучку. Начните разговор снова.");
    });
    if (state.outputMessage) {
      state.outputMessage.dataset.pending = "false";
      state.outputMessage = null;
      state.outputText = "";
    }
    if (wasInterrupted) {
      finishPlayback();
    } else if (!state.modelAudioReceivedInTurn) {
      state.pendingTurnComplete = false;
      finishPlayback();
      showError("Ответ пришёл без звука. Повторите фразу или начните разговор заново — другой голос не включён.");
    }
    refreshAfterForgetting();
  }

  // Slow searches must not block interruption/cancellation messages.
  if (payload.toolCall) {
    const socket = state.websocket;
    void handleToolCall(payload.toolCall, socket).catch((error) => {
      if (state.websocket === socket && state.sessionActive) showError(error.message || "Не удалось выполнить действие.");
    });
  }
}

function getSetupMessage(resumptionHandle = null) {
  return {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: elements.voice.value },
          },
        },
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
      systemInstruction: { parts: [{ text: getSystemInstruction() }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          prefixPaddingMs: 180,
          silenceDurationMs: 800,
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
        },
      },
      tools: [
        {
          functionDeclarations: [
            ...COMPANION_TOOLS,
            {
              name: "search_product_knowledge",
              description:
                "Ищет факты о функциях и ограничениях приложения. Не нужен для личной беседы, приветствий и вопросов о настроении.",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Короткий поисковый запрос на русском языке.",
                  },
                },
                required: ["query"],
              },
            },
            {
              name: "get_current_datetime",
              description:
                "Возвращает точные текущие дату, время и часовой пояс пользователя. Вызывай для вопросов о сегодняшней дате, текущем времени и относительных датах.",
              parameters: {
                type: "object",
                properties: {},
              },
            },
          ],
        },
      ],
      sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
      contextWindowCompression: {
        triggerTokens: 25000,
        slidingWindow: { targetTokens: 8000 },
      },
    },
  };
}

async function requestToken(signal) {
  const response = await fetch("/api/token", {
    method: "POST",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    throw new Error(body.error || "Не удалось создать голосовую сессию.");
  }
  return body.token;
}

function describeSocketClose(event) {
  const reason = event.reason?.toLocaleLowerCase("en") ?? "";
  if (reason.includes("quota")) {
    return "Для выбранной модели закончилась квота. Попробуйте позже или подключите биллинг.";
  }
  if (reason.includes("token") || reason.includes("auth")) {
    return "Не удалось обновить безопасную сессию Gemini. Начните разговор ещё раз.";
  }
  return "Голосовая сессия завершилась. Начните новый разговор.";
}

function openSocket(token, resumptionHandle = null) {
  const socket = new WebSocket(`${LIVE_ENDPOINT}?access_token=${encodeURIComponent(token)}`);
  const setupTimeout = setTimeout(() => {
    if (state.websocket === socket && !state.connected) socket.close(4000, "Setup timeout");
  }, 12_000);
  state.websocket = socket;

  socket.addEventListener("open", () => {
    if (state.websocket === socket && state.sessionActive) {
      socket.send(JSON.stringify(getSetupMessage(resumptionHandle)));
    }
  });

  let incoming = Promise.resolve();
  socket.addEventListener("message", (event) => {
    incoming = incoming.then(async () => {
      const raw = event.data instanceof Blob ? await event.data.text() : event.data;
      if (state.websocket !== socket || !state.sessionActive) return;
      const payload = JSON.parse(raw);
      if (payload.setupComplete) clearTimeout(setupTimeout);
      await parseServerMessage(payload);
    }).catch((error) => {
      if (state.websocket === socket) showError(error?.message || "Получен некорректный ответ Gemini. Перезапустите разговор.");
    });
  });

  socket.addEventListener("close", (event) => {
    clearTimeout(setupTimeout);
    if (state.websocket !== socket) return;
    state.websocket = null;
    state.connected = false;
    if (!state.sessionActive) return;
    state.connecting = true;

    const reason = event.reason?.toLocaleLowerCase("en") ?? "";
    const canRetry = !reason.includes("quota") && state.reconnectAttempts < 2;
    if (canRetry) {
      state.reconnectAttempts += 1;
      state.reconnecting = false;
      setUiState("connecting", "Восстанавливаю разговор");
      setTimeout(() => {
        reconnectSession({
          forceFresh: !state.resumptionHandle || state.reconnectAttempts > 1,
        });
      }, 250);
      return;
    }

    disconnect({ preserveError: true }).then(() => {
      showError(describeSocketClose(event));
    });
  });

  return socket;
}

async function reconnectSession({ forceFresh = false } = {}) {
  if (!state.sessionActive || state.reconnecting || !state.microphone || !state.playback) return;
  state.reconnecting = true;
  state.connected = false;
  state.connecting = true;
  if (forceFresh || !state.resumptionHandle) {
    // A fresh provider session cannot send the old turn's completion marker.
    // Finish audio already received, otherwise the protected mic stays gated.
    state.locallyInterrupted = false;
    if (state.modelAudioReceivedInTurn) {
      state.pendingTurnComplete = true;
      state.playback.completeTurn()?.catch(() => { finishPlayback(); });
    } else finishPlayback();
  }
  setConversationControls(true);
  setUiState("connecting", "Восстанавливаю разговор");

  const previousSocket = state.websocket;
  state.websocket = null;
  previousSocket?.close();

  try {
    if (forceFresh || !state.sessionToken) {
      state.connectAbortController = new AbortController();
      state.sessionToken = await requestToken(state.connectAbortController.signal);
    }
    if (!state.sessionActive) return;
    const handle = forceFresh ? null : state.resumptionHandle;
    if (forceFresh) { state.resumptionHandle = null; finishContextTurn({ interrupted: true }); }
    openSocket(state.sessionToken, handle);
  } catch (error) {
    state.reconnecting = false;
    if (error?.name === "AbortError" || !state.sessionActive) return;
    await disconnect({ preserveError: true });
    showError(error?.message || "Не удалось восстановить разговор. Начните его ещё раз.");
  }
}

async function connect() {
  if (state.sessionActive) return;
  const interactionId = ++state.interactionId;
  state.sessionActive = true;
  clearError();
  state.connecting = true;
  setConversationControls(true);
  elements.connection.textContent = "Подключаем";
  setUiState("connecting", "Подключаю безопасную сессию");

  try {
    state.playback = new StreamingPlayer(
      (level) => {
        document.documentElement.style.setProperty("--orb-level", String(level));
      },
      () => {
        if (state.pendingTurnComplete) {
          finishPlayback();
        }
      },
    );
    await state.playback.init();
    if (!state.sessionActive || state.interactionId !== interactionId) return;

    state.connectAbortController = new AbortController();
    const token = await requestToken(state.connectAbortController.signal);
    if (!state.sessionActive || state.interactionId !== interactionId) return;
    state.sessionToken = token;

    state.microphone = new MicrophoneStream(handleMicrophoneAudio);
    await state.microphone.start();
    if (!state.sessionActive || state.interactionId !== interactionId) {
      await state.microphone.stop();
      return;
    }

    openSocket(token);
  } catch (error) {
    if (error?.name === "AbortError" || !state.sessionActive) return;
    await disconnect({ preserveError: true });
    showError(
      error?.name === "NotAllowedError"
        ? "Разрешите доступ к микрофону в настройках браузера и попробуйте снова."
        : error?.message || "Не удалось начать разговор. Попробуйте ещё раз.",
    );
  }
}

function startSessionTimer() {
  state.sessionStartedAt = Date.now();
  clearInterval(state.sessionTimer);
  const update = () => {
    const elapsed = Math.floor((Date.now() - state.sessionStartedAt) / 1000);
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const seconds = String(elapsed % 60).padStart(2, "0");
    elements.sessionTime.textContent = `${minutes}:${seconds}`;
  };
  update();
  state.sessionTimer = setInterval(update, 1000);
}

function resetUi() {
  clearResponseWatchdog();
  state.awaitingResponse = false;
  state.connectAbortController = null;
  state.connected = false;
  state.connecting = false;
  state.websocket = null;
  state.localSpeechFrames = 0;
  state.localSilenceStartedAt = null;
  state.localSpeechActive = false;
  state.lastLocalSpeechAt = null;
  state.locallyInterrupted = false;
  state.interruptionStartedAt = null;
  state.modelAudioReceivedInTurn = false;
  state.pendingTurnComplete = false;
  state.reconnectAttempts = 0;
  state.reconnecting = false;
  state.resumptionHandle = null;
  state.sessionToken = null;
  state.sessionActive = false;
  state.turnOutputText = "";
  state.turnUserText = "";
  state.pendingSources = [];
  state.lastModelMessage = null;
  state.toolGeneration += 1;
  state.refreshAfterForget = false;
  state.replyPlaying = false;
  state.micResumeAt = 0;
  state.micPaused = false;
  state.generationComplete = false;
  clearInterval(state.sessionTimer);
  state.sessionTimer = null;
  state.sessionStartedAt = null;
  elements.sessionTime.textContent = "00:00";
  setConversationControls(false);
  setUiState("idle", "Готова к разговору");
  document.documentElement.style.setProperty("--orb-level", "0");
}

async function disconnect({ preserveError = false } = {}) {
  finishContextTurn({ interrupted: true });
  state.sessionActive = false;
  state.interactionId += 1;
  state.connectAbortController?.abort();
  clearResponseWatchdog();
  state.connected = false;
  state.connecting = false;
  if (state.websocket) {
    const socket = state.websocket;
    state.websocket = null;
    socket.close();
  }
  await Promise.allSettled([state.microphone?.stop(), state.playback?.destroy()]);
  state.microphone = null;
  state.playback = null;
  if (!preserveError) clearError();
  resetUi();
}

const SETTINGS_KEY = "manyasha.conversation.v3";

function saveConversationSettings() {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode: elements.mode.value, profanity: elements.profanity.value,
      voice: elements.voice.value, voiceInterrupt: elements.voiceInterrupt.checked,
    }));
  } catch { /* Conversation still works when storage is unavailable. */ }
}

function loadConversationSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null");
    if (!saved) return;
    if (MODE_DEFINITIONS[saved.mode]) elements.mode.value = saved.mode;
    if (["off", "moderate", "free", "always"].includes(saved.profanity)) elements.profanity.value = saved.profanity;
    if (["Kore", "Aoede", "Puck", "Fenrir", "Charon"].includes(saved.voice)) elements.voice.value = saved.voice;
    elements.voiceInterrupt.checked = saved.voiceInterrupt === true;
  } catch { /* Keep the safe conversation defaults if preferences are invalid. */ }
}

elements.button.addEventListener("click", () => {
  if (state.sessionActive) disconnect();
  else connect();
});
elements.interrupt.addEventListener("click", interruptReply);

elements.mode.addEventListener("change", () => {
  syncConversationSettings({ modeChanged: true });
  saveConversationSettings();
});

elements.profanity.addEventListener("change", () => {
  syncConversationSettings();
  saveConversationSettings();
});

elements.voice.addEventListener("change", () => { syncConversationSettings(); saveConversationSettings(); });
elements.voiceInterrupt.addEventListener("change", () => { syncConversationSettings(); saveConversationSettings(); });

window.addEventListener("pagehide", () => {
  const socket = state.websocket;
  state.websocket = null;
  socket?.close();
  state.microphone?.stream?.getTracks().forEach((track) => track.stop());
});

setUiState("idle", "Готова к разговору");
memoryPanel = createMemoryPanel(memoryStore, () => conversationContext.clear());
window.addEventListener("storage", async (event) => {
  if (event.key !== MEMORY_KEY && event.key !== null) return;
  if (state.sessionActive) await disconnect();
  conversationContext.clear(); memoryStore.load(); memoryPanel.render();
  memoryPanel.announce("Память изменена в другой вкладке. Начните новый разговор, чтобы использовать обновлённые заметки.");
});
loadConversationSettings();
syncConversationSettings();
