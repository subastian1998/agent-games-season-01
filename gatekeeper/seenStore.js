// Proof Gatekeeper — persistent proof_tx seen-set.
//
// Why this exists: decide() must flag PROOF_REUSED (same proof_tx under a
// different task_id). v1 kept that set in an in-memory Map, so every server
// restart / redeploy wiped it and a reused proof was missed afterwards —
// the agent would APPROVE (or evaluate the other traps) instead of
// REJECT/PROOF_REUSED. A wrong APPROVE costs -6 instead of +12, an
// 18-point swing per missed trap. This store keeps the exact same Map
// semantics but appends every new record to a JSONL file (fsync per
// record) and replays the file at startup, so the set survives process
// restarts and crashes.
//
// Limits (be honest about them):
//  - A Railway REDEPLOY creates a fresh container, so the file alone does
//    NOT survive a redeploy. Mount a Railway Volume at the data dir and
//    point GATEKEEPER_SEEN_FILE at it (see UPGRADE-v2-REPORT.md). Without
//    a volume the file still survives crashes/restarts within one deploy.
//  - The file holds only public proof_tx hashes + task_ids — no secrets.
//
// Safety rules:
//  - Persistence failure NEVER breaks request handling: record() catches
//    all errors, warns, and keeps the in-memory entry.
//  - Malformed lines are skipped on load, never fatal.
//  - First-seen wins (matches decide(): a second task_id for the same
//    proof_tx is a reuse and is never recorded).
//  - The store is synchronous by design: decide() is synchronous, so a
//    record inside decide() is atomic w.r.t. concurrent requests.
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, 'seen-proof-tx.jsonl');

function resolveConfig(opts = {}) {
  const file = opts.filePath || process.env.GATEKEEPER_SEEN_FILE || DEFAULT_FILE;
  const persist = opts.persist !== undefined ? !!opts.persist : process.env.GATEKEEPER_SEEN_PERSIST !== '0';
  return { file, persist };
}

class SeenStore {
  constructor(opts = {}) {
    const { file, persist } = resolveConfig(opts);
    this.file = file;
    this.persist = persist;
    this.map = new Map(); // proof_tx (lowercased) -> task_id
    this.fd = null;
    this._load();
    if (this.persist) this._open();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[seen-store] could not read seen file:', e.message);
      return;
    }
    let loaded = 0;
    let skipped = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (typeof rec.tx !== 'string' || typeof rec.task !== 'string') { skipped++; continue; }
        const tx = rec.tx.toLowerCase();
        if (!this.map.has(tx)) { this.map.set(tx, rec.task); loaded++; }
      } catch { skipped++; }
    }
    if (loaded || skipped) {
      console.log(`[seen-store] loaded ${loaded} proof_tx from ${this.file}${skipped ? ` (${skipped} malformed lines skipped)` : ''}`);
    }
  }

  _open() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fd = fs.openSync(this.file, 'a');
    } catch (e) {
      console.warn('[seen-store] persistence disabled — could not open seen file:', e.message);
      this.persist = false;
      this.fd = null;
    }
  }

  has(tx) { return this.map.has(String(tx || '').toLowerCase()); }
  get(tx) { return this.map.get(String(tx || '').toLowerCase()); }
  size() { return this.map.size; }

  // Record a first sighting. Returns true if newly recorded, false if already known.
  // Synchronous + fsync: a crash right after decide() must not lose the record.
  record(tx, taskId) {
    const key = String(tx || '').toLowerCase();
    if (!key) return false;
    if (this.map.has(key)) return false;
    this.map.set(key, String(taskId || ''));
    if (this.persist && this.fd !== null) {
      try {
        const line = JSON.stringify({ tx: key, task: String(taskId || ''), ts: Date.now() }) + '\n';
        fs.writeSync(this.fd, line);
        fs.fsyncSync(this.fd);
      } catch (e) {
        console.warn('[seen-store] could not persist proof_tx (kept in memory):', e.message);
      }
    }
    return true;
  }

  // Test-only: clear the in-memory map. Does NOT truncate the file
  // (production state must never be wiped by a test reset).
  clear() { this.map.clear(); }
}

let defaultStore = null;
function getDefaultStore() {
  if (!defaultStore) defaultStore = new SeenStore();
  return defaultStore;
}
function createSeenStore(opts) { return new SeenStore(opts); }

module.exports = { SeenStore, createSeenStore, getDefaultStore };
