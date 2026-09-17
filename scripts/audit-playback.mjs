// Offline end-to-end PCM audit: production StreamingPlayer -> production worklet.
// Does not use the microphone, speakers, network, or real browser storage.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import * as persona from "../public/persona.js";
import * as memory from "../public/memory.js";
import { COMPANION_TOOLS } from "../public/companion-tools.js";

let Processor;
class AudioWorkletProcessor { constructor() { this.port = {}; } }
vm.runInNewContext(readFileSync(new URL("../public/playback.worklet.js", import.meta.url), "utf8"), {
  sampleRate: 48000, AudioWorkletProcessor, registerProcessor: (_name, ctor) => { Processor = ctor; },
});
class AudioContext {
  constructor() { this.state = "running"; this.sampleRate = 48000; this.audioWorklet = { addModule: async () => {} }; }
  async resume() {}
}
class AudioWorkletNode {
  constructor() {
    this.processor = new Processor();
    this.port = { postMessage: (data) => this.processor.port.onmessage({ data }) };
    this.processor.port.postMessage = (data) => this.port.onmessage?.({ data });
  }
  connect() {}
  render() {
    const before = this.processor.bufferedFrames;
    const block = new Float32Array(128);
    this.processor.process([], [[block]]);
    return block.subarray(0, before - this.processor.bufferedFrames);
  }
}
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\s*/gm, "").split('elements.button.addEventListener("click"')[0];
const context = vm.createContext({ ...persona, ...memory, COMPANION_TOOLS, AudioContext, AudioWorkletNode,
  atob, document: { querySelector: () => ({}), documentElement: { style: { setProperty() {} } } },
  window: { localStorage: { getItem: () => null, setItem() {} } } });
vm.runInContext(source, context);
const { StreamingPlayer, resampleLinear } = vm.runInContext("({ StreamingPlayer, resampleLinear })", context);

for (const file of process.argv.slice(2)) {
  const wav = readFileSync(file);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 36, 40), "data", "Expected WAV from check-voice.mjs");
  const rate = wav.readUInt32LE(24), pcm = wav.subarray(44);
  let drained = 0;
  const player = new StreamingPlayer(() => {}, () => drained++);
  await player.init();
  const expected = [], played = [];
  const render = (blocks) => { for (let i = 0; i < blocks; i++) played.push(...player.node.render()); };
  let offset = 0;
  while (offset < pcm.length) {
    // Deliberately force a final 31-sample tail and repeated network underflows.
    const remaining = pcm.length - offset;
    const size = remaining > 62 ? Math.min(4096, remaining - 62) : remaining;
    const chunk = pcm.subarray(offset, offset + size); offset += size;
    const decoded = Float32Array.from({ length: size / 2 }, (_, i) => chunk.readInt16LE(i * 2) / 32768);
    expected.push(...resampleLinear(decoded, rate, 48000));
    const push = player.push(chunk.toString("base64"), rate);
    if (offset === pcm.length) {
      const complete = player.completeTurn();
      await Promise.all([push, complete]);
    } else await push;
    render(100);
  }
  render(100);
  assert.equal(drained, 1, "Must report completion exactly once");
  assert.equal(played.length, expected.length, "No lost samples, including final syllables");
  assert.deepEqual(played, expected, "Playback PCM must match generated PCM after resampling");
  console.log(JSON.stringify({ file, generatedFrames: expected.length, playedFrames: played.length, drained, exactMatch: true }));
}
