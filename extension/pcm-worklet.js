// Hands raw audio (mixed to mono) from the audio thread to the offscreen page, for the voice detector.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const n = chans[0].length, mono = new Float32Array(n);
      for (let c = 0; c < chans.length; c++) for (let i = 0; i < n; i++) mono[i] += chans[c][i] / chans.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
