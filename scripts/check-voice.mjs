// Opt-in live check: uses the configured Gemini key and saves only generated audio.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { loadLocalEnv, createTokenPayload, searchKnowledge } from "../server.mjs";
import * as persona from "../public/persona.js";
import * as memory from "../public/memory.js";
import { COMPANION_TOOLS } from "../public/companion-tools.js";
import { searchWeb } from "../web-search.mjs";

loadLocalEnv();
const [label = "check", mode = "friend", profanity = "free", ...questions] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Use a simple output label");
const output = resolve("voice-checks", label);
mkdirSync(output, { recursive: true });
const prompts = questions.length ? questions : ["Как дела?"];
// Shared synthetic test memory; never reads a real browser profile.
const memoryFile = resolve("voice-checks", "synthetic-memory.json");
const storage = {
  getItem: () => existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : null,
  setItem: (_key, value) => writeFileSync(memoryFile, value),
};
const controls = new Map();
const document = {
  querySelector(selector) {
    if (!controls.has(selector)) controls.set(selector, {
      value: selector === "#mode-select" ? mode : selector === "#profanity-select" ? profanity : "Puck",
    });
    return controls.get(selector);
  },
};
// Use the actual app's setup, including tools and audio configuration.
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\s*/gm, "")
  .split('elements.button.addEventListener("click"')[0];
const context = vm.createContext({ ...persona, ...memory, COMPANION_TOOLS, document, Intl, Date, window: { localStorage: storage } });
vm.runInContext(app, context);
const setup = vm.runInContext("getSetupMessage()", context);

const tokenResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
  body: JSON.stringify(createTokenPayload()),
  signal: AbortSignal.timeout(15000),
});
const token = await tokenResponse.json();
if (!tokenResponse.ok || !token.name) throw new Error(`Token request failed: ${tokenResponse.status}`);

function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const results = [];
await new Promise((resolveCheck, rejectCheck) => {
  const socket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token.name)}`);
  let index = 0, text = "", chunks = [], rate = 24000, timeout, finished = false;
  const fail = (error) => { if (finished) return; finished = true; clearTimeout(timeout); socket.close(); rejectCheck(error); };
  const send = (message) => socket.send(JSON.stringify(message));
  const next = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fail(new Error("Live response timed out")), 30000);
    send({ clientContent: { turns: [{ role: "user", parts: [{ text: prompts[index] }] }], turnComplete: true } });
  };
  timeout = setTimeout(() => fail(new Error("Setup timed out")), 20000);
  socket.addEventListener("open", () => send(setup));
  let messages = Promise.resolve();
  socket.addEventListener("message", (event) => {
    messages = messages.then(async () => {
      const payload = JSON.parse(event.data instanceof Blob ? await event.data.text() : event.data);
      if (payload.error) throw new Error(payload.error.message);
      if (payload.setupComplete) { next(); return; }
      if (payload.toolCall) {
        const records = JSON.parse(readFileSync(new URL("../data/knowledge.json", import.meta.url), "utf8"));
        const store = vm.runInContext("memoryStore", context);
        const responses = [];
        for (const call of payload.toolCall.functionCalls) {
          let response;
          if (["read_memory", "remember_fact", "forget_fact"].includes(call.name)) response = memory.runMemoryTool(store, call, prompts.slice(Math.max(0, index - 2), index + 1));
          else if (call.name === "search_product_knowledge") response = { results: searchKnowledge(call.args?.query ?? "", records) };
          else if (call.name === "search_web") response = await searchWeb(call.args?.query ?? "", { apiKey: process.env.GEMINI_API_KEY });
          else if (call.name === "get_current_datetime") response = { iso: new Date().toISOString(), timezone: "Europe/Amsterdam" };
          else response = { error: "Unknown tool" };
          console.log(JSON.stringify({ tool: call.name, response }));
          responses.push({ id: call.id, name: call.name, response });
        }
        send({ toolResponse: { functionResponses: responses } });
      }
      const content = payload.serverContent;
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          chunks.push(Buffer.from(part.inlineData.data, "base64"));
          rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? rate);
        }
      }
      text += content?.outputTranscription?.text ?? "";
      if (content?.turnComplete) {
        const pcm = Buffer.concat(chunks);
        const audioFile = pcm.length ? resolve(output, `${index + 1}.wav`) : null;
        if (audioFile) writeFileSync(audioFile, wav(pcm, rate));
        const result = { prompt: prompts[index], text, audioBytes: pcm.length,
          audioSeconds: Number((pcm.length / rate / 2).toFixed(2)), audioFile };
        results.push(result);
        console.log(JSON.stringify(result));
        index++; text = ""; chunks = [];
        if (index < prompts.length) next();
        else { finished = true; clearTimeout(timeout); socket.close(); resolveCheck(); }
      }
    }).catch(fail);
  });
  socket.addEventListener("error", () => fail(new Error("WebSocket failed")));
  socket.addEventListener("close", (event) => { if (!finished) fail(new Error(`Closed: ${event.code} ${event.reason}`)); });
});
writeFileSync(resolve(output, "results.json"), JSON.stringify({ mode, profanity, results }, null, 2));
if (results.some((result) => !result.audioBytes)) process.exitCode = 2;
