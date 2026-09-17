class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputBuffer = [];
    this.outputBuffer = [];
    this.readPosition = 0;
    this.resampleRatio = sampleRate / 16000;
    this.targetChunkSize = 640;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let index = 0; index < input.length; index += 1) {
      this.inputBuffer.push(input[index]);
    }

    while (this.readPosition + 1 < this.inputBuffer.length) {
      const leftIndex = Math.floor(this.readPosition);
      const fraction = this.readPosition - leftIndex;
      const left = this.inputBuffer[leftIndex];
      const right = this.inputBuffer[leftIndex + 1];
      this.outputBuffer.push(left + (right - left) * fraction);
      this.readPosition += this.resampleRatio;
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed > 0) {
      this.inputBuffer.splice(0, consumed);
      this.readPosition -= consumed;
    }

    while (this.outputBuffer.length >= this.targetChunkSize) {
      const chunk = new Float32Array(this.outputBuffer.splice(0, this.targetChunkSize));
      let energy = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        energy += chunk[index] * chunk[index];
      }
      const rms = Math.sqrt(energy / chunk.length);
      this.port.postMessage({ type: "audio", samples: chunk, rms }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
