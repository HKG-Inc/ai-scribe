class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.port.onmessage = (event) => {
      if (event.data?.command === "reset") {
        this.queue = [];
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.queue.push(new Int16Array(event.data));
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    for (let i = 0; i < output.length; i++) {
      if (this.queue.length && this.queue[0].length) {
        output[i] = this.queue[0][0] / 32768;
        this.queue[0] = this.queue[0].subarray(1);
        if (!this.queue[0].length) {
          this.queue.shift();
        }
      } else {
        output[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-player-processor", PcmPlayerProcessor);
