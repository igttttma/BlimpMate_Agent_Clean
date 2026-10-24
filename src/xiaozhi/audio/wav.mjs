// Decodes a WAV file (PCM 16-bit or float 32-bit, any channel count) to mono
// Float32 at the requested rate, for the reply player (wake greetings).

export function decodeWav(arrayBuffer, targetRate) {
  const view = new DataView(arrayBuffer);
  const tag = (at) => String.fromCharCode(
    view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (view.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");

  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= view.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      };
    } else if (id === "data") {
      // Streamed WAVs can leave the size unset: take the rest of the file
      data = { offset: body, size: Math.min(size, view.byteLength - body) };
      break;
    }
    at = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV without fmt or data chunk");

  const pcm16 = fmt.format === 1 && fmt.bits === 16;
  const float32 = fmt.format === 3 && fmt.bits === 32;
  if (!pcm16 && !float32) throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}-bit`);
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.size / (bytes * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const at = data.offset + (i * fmt.channels + c) * bytes;
      sum += pcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
    }
    mono[i] = sum / fmt.channels;
  }
  return resample(mono, fmt.rate, targetRate);
}

// Linear resampling, like the playback worklet's
function resample(samples, fromRate, toRate) {
  if (!toRate || fromRate === toRate) return samples;
  const out = new Float32Array(Math.floor(samples.length * toRate / fromRate));
  const step = fromRate / toRate;
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const base = Math.floor(pos);
    const next = Math.min(base + 1, samples.length - 1);
    out[i] = samples[base] + (samples[next] - samples[base]) * (pos - base);
  }
  return out;
}
