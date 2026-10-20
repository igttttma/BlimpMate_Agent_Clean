// Local copies of the portal's videos, so "Play now" starts at once instead of
// waiting on the network. The server sends the full video list (with signed
// links) when the control socket connects and whenever the library changes;
// the cache downloads what it lacks, one video at a time, and drops videos
// the server no longer has. A stored video never changes (a new upload gets
// a new id), so the id is the cache key.
//
// Storage is IndexedDB: a video is kept as a run of 8 MB Blob chunks, written
// as they arrive, so a large download never sits in memory and an interrupted
// one resumes with a Range request from the bytes already stored.

const DB_NAME = "blimpmate-video-cache";
const DB_VERSION = 1;
const CHUNK_BYTES = 8 * 1024 * 1024;
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const PROGRESS_MS = 500;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

function openDb() {
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    // videos: { id, title, mime, size, received, chunks, complete }
    db.createObjectStore("videos", { keyPath: "id" });
    // chunks: Blob, key [id, index]
    db.createObjectStore("chunks");
  };
  return req(open);
}

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export class VideoCache extends EventTarget {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.entries = new Map(); // id -> stored record
    this.urls = new Map(); // id -> object URL of a complete video
    this.jobs = new Map(); // id -> { state: queued|downloading|failed, error?, attempt }
    this.listed = new Map(); // id -> { id, title, mime, size, url } from the last server list
    this._db = null;
    this._ready = this._load();
    this._running = false;
    this._abort = null; // aborts the current download
    this._current = null;
    this._retryTimer = null;
    this._lastProgress = 0;
  }

  async _load() {
    try {
      this._db = await openDb();
      const tx = this._db.transaction("videos");
      for (const entry of await req(tx.objectStore("videos").getAll())) {
        this.entries.set(entry.id, entry);
        if (entry.complete) await this._makeUrl(entry);
      }
      navigator.storage?.persist?.().catch(() => {});
    } catch (err) {
      this._db = null;
      this.log("warn", "Video cache unavailable; videos will stream", { error: String(err?.message || err) });
    }
  }

  /** A local URL for the video, or null when it isn't fully cached. */
  urlFor(id) {
    return this.urls.get(id) || null;
  }

  /** Per-video cache state for the portal: { id: { state, received, size, error? } }. */
  status() {
    const out = {};
    for (const [id, item] of this.listed) {
      const entry = this.entries.get(id);
      const job = this.jobs.get(id);
      out[id] = {
        state: this.urls.has(id) ? "cached" : job?.state || "queued",
        received: entry?.received || 0,
        size: item.size
      };
      if (job?.error) out[id].error = job.error;
    }
    return out;
  }

  /** Apply the server's video list: [{ id, title, mime, size, url }]. */
  async sync(videos) {
    await this._ready;
    this.listed = new Map(videos.map((v) => [v.id, v]));
    for (const id of [...this.entries.keys()]) {
      if (!this.listed.has(id)) await this._remove(id);
    }
    for (const id of [...this.jobs.keys()]) {
      if (!this.listed.has(id)) this.jobs.delete(id);
    }
    for (const v of videos) {
      // Fresh signed links on every list: failed downloads get another try
      if (!this.urls.has(v.id) && this.jobs.get(v.id)?.state !== "downloading") {
        this.jobs.set(v.id, { state: "queued", attempt: 0 });
      }
    }
    this._changed();
    clearTimeout(this._retryTimer);
    this._run();
  }

  // ---- downloads ----

  async _run() {
    if (this._running || !this._db) return;
    this._running = true;
    try {
      for (;;) {
        const next = [...this.listed.values()].find((v) => this.jobs.get(v.id)?.state === "queued");
        if (!next) break;
        await this._download(next);
      }
    } finally {
      this._running = false;
    }
    // Downloads that failed on the network retry on their own
    const waiting = [...this.jobs.values()].filter((j) => j.state === "failed" && j.retry);
    if (waiting.length) {
      const delay = Math.min(...waiting.map((j) => RETRY_MS[Math.min(j.attempt - 1, RETRY_MS.length - 1)]));
      this._retryTimer = setTimeout(() => {
        for (const j of waiting) if (j.state === "failed") j.state = "queued";
        this._run();
      }, delay);
    }
  }

  async _download(video) {
    const job = this.jobs.get(video.id);
    job.state = "downloading";
    job.error = undefined;
    this._changed();
    const abort = new AbortController();
    this._abort = abort;
    this._current = video.id;
    let entry = this.entries.get(video.id);
    if (!entry || entry.size !== video.size) {
      if (entry) await this._remove(video.id);
      entry = { id: video.id, title: video.title, mime: video.mime, size: video.size, received: 0, chunks: 0, complete: false };
      await this._put(entry);
    }
    const started = performance.now();
    const resumedAt = entry.received;
    try {
      const headers = entry.received ? { Range: `bytes=${entry.received}-` } : {};
      const res = await fetch(video.url, { headers, signal: abort.signal, cache: "no-store" });
      if (res.status === 200 && entry.received) {
        // The server ignored the range: start over
        await this._remove(video.id, { abort: false });
        entry = { ...entry, received: 0, chunks: 0 };
        await this._put(entry);
      } else if (!res.ok) {
        throw new HttpError(res.status);
      }
      const reader = res.body.getReader();
      let parts = [];
      let pending = 0;
      const flush = async () => {
        if (!pending) return;
        if (abort.signal.aborted) throw new DOMException("removed", "AbortError");
        const blob = new Blob(parts, { type: entry.mime });
        parts = [];
        const tx = this._db.transaction(["videos", "chunks"], "readwrite");
        tx.objectStore("chunks").put(blob, [entry.id, entry.chunks]);
        entry = { ...entry, chunks: entry.chunks + 1, received: entry.received + pending };
        tx.objectStore("videos").put(entry);
        pending = 0;
        await done(tx);
        this.entries.set(entry.id, entry);
      };
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value);
        pending += value.byteLength;
        if (pending >= CHUNK_BYTES) await flush();
        this._progress(entry.received + pending);
      }
      await flush();
      if (entry.received !== entry.size) throw new Error(`got ${entry.received} of ${entry.size} bytes`);
      entry = { ...entry, complete: true };
      await this._put(entry);
      await this._makeUrl(entry);
      this.jobs.delete(video.id);
      const secs = (performance.now() - started) / 1000;
      this.log("info", `Video cached: ${video.title}`, {
        id: video.id, mb: +(video.size / 1048576).toFixed(1), seconds: +secs.toFixed(1),
        ...(resumedAt ? { resumedFrom: resumedAt } : {})
      });
    } catch (err) {
      if (!this.listed.has(video.id)) return; // deleted on the server while downloading
      const expired = err instanceof HttpError && (err.status === 403 || err.status === 404);
      job.state = "failed";
      job.attempt++;
      // An expired link waits for the next list (sent on every reconnect)
      job.retry = !expired;
      job.error = expired ? (err.status === 404 ? "not on the server" : "link expired") : String(err?.message || err);
      this.log("warn", `Video download failed: ${video.title}`, { id: video.id, error: job.error });
    } finally {
      if (this._abort === abort) this._abort = null;
      this._current = null;
      this._changed();
    }
  }

  _progress(received) {
    const now = performance.now();
    if (now - this._lastProgress < PROGRESS_MS) return;
    this._lastProgress = now;
    const entry = this.entries.get(this._current);
    if (entry) this.entries.set(entry.id, { ...entry, received });
    this._changed();
  }

  // ---- storage ----

  async _makeUrl(entry) {
    const store = this._db.transaction("chunks").objectStore("chunks");
    const chunks = await Promise.all(
      Array.from({ length: entry.chunks }, (_, i) => req(store.get([entry.id, i])))
    );
    if (chunks.some((c) => !c)) {
      // Lost chunks (storage cleared under us): download it again
      await this._remove(entry.id);
      return;
    }
    // Chunk blobs are backed by IndexedDB files; joining them copies nothing
    this.urls.set(entry.id, URL.createObjectURL(new Blob(chunks, { type: entry.mime })));
  }

  async _put(entry) {
    const tx = this._db.transaction("videos", "readwrite");
    tx.objectStore("videos").put(entry);
    await done(tx);
    this.entries.set(entry.id, entry);
  }

  async _remove(id, { abort = true } = {}) {
    if (abort && this._current === id) this._abort?.abort();
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.entries.delete(id);
    if (!this._db) return;
    const tx = this._db.transaction(["videos", "chunks"], "readwrite");
    tx.objectStore("videos").delete(id);
    tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    await done(tx);
  }

  _changed() {
    this.dispatchEvent(new Event("change"));
  }
}
