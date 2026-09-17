import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function worklet(file, sampleRate = 48000) {
  let Processor; const events = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: (message) => events.push(message) }; } }
  const context = vm.createContext({ sampleRate, AudioWorkletProcessor, registerProcessor: (_name, constructor) => { Processor = constructor; } });
  vm.runInContext(readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"), context);
  const processor = new Processor();
  return { processor, events, send: (data) => processor.port.onmessage({ data }), render: () => {
    const output = new Float32Array(128); processor.process([], [[output]]); return output;
  } };
}

test("playback begins after a 30 ms safety buffer", () => {
  const player = worklet("playback.worklet.js");
  assert.equal(player.processor.minBufferedFrames, 1440);
  player.send({ type: "push", samples: new Float32Array(1439).fill(.25) });
  assert.equal(player.processor.started, false);
  player.send({ type: "push", samples: new Float32Array(1).fill(.25) });
  assert.equal(player.processor.started, true);
});

test("late turnComplete acknowledges audio already drained during a network gap", () => {
  const player = worklet("playback.worklet.js");
  player.send({ type: "push", samples: new Float32Array(4096).fill(.25) });
  for (let i = 0; i < 40; i++) player.render();
  assert.equal(player.processor.started, false);
  player.send({ type: "turn-complete" }); player.render(); player.render();
  assert.equal(player.events.filter((event) => event.type === "drained").length, 1);
});

test("sub-buffer final audio tail is rendered completely before drained", () => {
  const player = worklet("playback.worklet.js");
  player.send({ type: "push", samples: new Float32Array(4096).fill(.25) });
  const played = [];
  for (let i = 0; i < 40; i++) played.push(...player.render());
  player.send({ type: "push", samples: new Float32Array(257).fill(.5) });
  player.send({ type: "turn-complete" });
  for (let i = 0; i < 5; i++) played.push(...player.render());
  assert.equal(played.filter((sample) => sample === .25).length, 4096);
  assert.equal(played.filter((sample) => sample === .5).length, 257);
  assert.equal(player.events.filter((event) => event.type === "drained").length, 1);
});

test("explicit clear discards only cancelled generation and next turn drains normally", () => {
  const player = worklet("playback.worklet.js");
  player.send({ type: "push", samples: new Float32Array(4096).fill(.25) });
  player.send({ type: "clear", generation: 2 });
  player.send({ type: "push", samples: new Float32Array(200).fill(.5), generation: 2 });
  player.send({ type: "turn-complete", generation: 2 });
  const played = [...player.render(), ...player.render(), ...player.render()];
  assert.equal(played.filter((sample) => sample === .25).length, 0);
  assert.equal(played.filter((sample) => sample === .5).length, 200);
  assert.equal(player.events.find((event) => event.type === "drained").generation, 2);
});

test("capture preserves resampling phase across 128-frame render boundaries", () => {
  const { processor, events } = worklet("capture.worklet.js");
  for (let block = 0; block < 480; block++) {
    const input = Float32Array.from({ length: 128 }, (_, i) => (block * 128 + i) / 100000);
    processor.process([[input]]);
  }
  const actual = events.flatMap((event) => Array.from(event.samples));
  assert.equal(actual.length + processor.outputBuffer.length, 20480);
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - i * 3 / 100000) < 1e-7);
});
