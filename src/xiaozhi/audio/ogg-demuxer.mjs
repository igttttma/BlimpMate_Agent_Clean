// Demultiplex Ogg pages and yield raw Opus packets. Skips the two header
// packets (OpusHead + OpusTags). Stateful: feed arbitrary chunks via feed().
export class OggOpusDemuxer {
  constructor() {
    this._buf = new Uint8Array(0);
    this._headersSkipped = 0;
  }

  feed(chunk) {
    if (!chunk || chunk.length === 0) return [];
    const merged = new Uint8Array(this._buf.length + chunk.length);
    merged.set(this._buf, 0);
    merged.set(chunk, this._buf.length);
    this._buf = merged;
    return this._parse();
  }

  _parse() {
    const packets = [];
    let offset = 0;
    while (true) {
      if (this._buf.length - offset < 27) break;
      if (this._buf[offset] !== 0x4f /* O */ ||
          this._buf[offset + 1] !== 0x67 /* g */ ||
          this._buf[offset + 2] !== 0x67 /* g */ ||
          this._buf[offset + 3] !== 0x53 /* S */) {
        offset += 1;
        continue;
      }
      const segCount = this._buf[offset + 26];
      const headerLen = 27 + segCount;
      if (this._buf.length - offset < headerLen) break;

      const segTable = this._buf.subarray(offset + 27, offset + 27 + segCount);
      let payloadLen = 0;
      for (let i = 0; i < segCount; i++) payloadLen += segTable[i];

      const pageLen = headerLen + payloadLen;
      if (this._buf.length - offset < pageLen) break;

      const payload = this._buf.subarray(offset + headerLen, offset + pageLen);
      let p = 0;
      let curPacket = [];
      for (let i = 0; i < segCount; i++) {
        const segLen = segTable[i];
        curPacket.push(payload.subarray(p, p + segLen));
        p += segLen;
        if (segLen < 255) {
          // packet complete
          let total = 0;
          for (const s of curPacket) total += s.length;
          const out = new Uint8Array(total);
          let off = 0;
          for (const s of curPacket) { out.set(s, off); off += s.length; }
          if (this._headersSkipped < 2) {
            this._headersSkipped += 1;
          } else {
            packets.push(out);
          }
          curPacket = [];
        }
      }
      offset += pageLen;
    }
    if (offset > 0) {
      this._buf = this._buf.subarray(offset);
    }
    return packets;
  }

  reset() {
    this._buf = new Uint8Array(0);
    this._headersSkipped = 0;
  }
}
