// Drives the mouth from a playing <audio> element (portal audio clips, wake
// greetings). The element plays through this class's own AudioContext.

const LIP_SYNC_MS = 40;

// Needs CORS on the audio (the server's signed links send it)
export class LipSync {
  constructor(mouth) {
    this.mouth = mouth;
    this.ctx = null;
    this.source = null;
    this.timer = null;
  }

  start(audio) {
    this.stop();
    try {
      this.ctx ||= new AudioContext();
      this.ctx.resume().catch(() => {});
      const source = this.ctx.createMediaElementSource(audio);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyser.connect(this.ctx.destination);
      this.source = source;
      const buf = new Float32Array(analyser.fftSize);
      this.mouth.begin();
      this.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        this.mouth.feedRms(Math.sqrt(sum / buf.length));
      }, LIP_SYNC_MS);
    } catch {
      // No Web Audio: the clip still plays, the mouth stays still
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.source) return;
    try { this.source.disconnect(); } catch {}
    this.source = null;
    this.mouth.end();
  }
}
