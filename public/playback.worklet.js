class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.bufferedFrames = 0;
    this.started = false;
    this.turnComplete = false;
    this.minBufferedFrames = Math.round(sampleRate * 0.06);
    this.framesSinceLevel = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === "push" && event.data.samples) {
        this.queue.push(event.data.samples);
        this.bufferedFrames += event.data.samples.length;
        if (this.bufferedFrames >= this.minBufferedFrames) this.started = true;
      }
      if (event.data?.type === "turn-complete") {
        this.turnComplete = true;
        if (this.bufferedFrames > 0) this.started = true;
      }
      if (event.data?.type === "clear") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.bufferedFrames = 0;
        this.started = false;
        this.turnComplete = false;
        this.port.postMessage({ type: "level", value: 0 });
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    let energy = 0;
    let hasAudio = false;

    if (!this.started) {
      output.fill(0);
      return true;
    }

    for (let frame = 0; frame < output.length; frame += 1) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.queue.shift() ?? null;
        this.offset = 0;
      }

      const sample = this.current ? this.current[this.offset++] : 0;
      output[frame] = sample;
      if (this.current) this.bufferedFrames = Math.max(0, this.bufferedFrames - 1);
      energy += sample * sample;
      hasAudio ||= sample !== 0;
    }

    if (this.current && this.offset >= this.current.length) {
      this.current = null;
      this.offset = 0;
    }

    if (this.turnComplete && !hasAudio && this.bufferedFrames === 0 && !this.current) {
      this.started = false;
      this.turnComplete = false;
      this.port.postMessage({ type: "drained" });
    } else if (!this.turnComplete && !hasAudio && this.bufferedFrames === 0 && !this.current) {
      this.started = false;
    }

    this.framesSinceLevel += output.length;
    if (this.framesSinceLevel >= sampleRate * 0.04) {
      this.framesSinceLevel = 0;
      const rms = Math.sqrt(energy / output.length);
      this.port.postMessage({ type: "level", value: Math.min(1, rms * 5.5) });
    }

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
