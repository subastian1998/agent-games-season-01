// Worker for gatekeeper/test-restart.js — runs in a SEPARATE node process
// so a real process restart is exercised (not just a re-require).
// Usage:
//   node gatekeeper/test-restart-worker.js record <file>  — records one proof_tx, exits
//   node gatekeeper/test-restart-worker.js check <file>   — reloads from file, verifies reuse detection
// The file path comes from argv (never the production file).
const fs = require('fs');

const mode = process.argv[2];
const file = process.argv[3];
if (!mode || !file) { console.error('usage: test-restart-worker.js <record|check> <file>'); process.exit(2); }
process.env.GATEKEEPER_SEEN_FILE = file;
process.env.GATEKEEPER_SEEN_PERSIST = '1';

const { createSeenStore } = require('./seenStore');
const { decide } = require('./decide');

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const ADDR = '0x1111111111111111111111111111111111111111';
function base(overrides = {}) {
  return Object.assign({
    task_id: 'gk_restart_1', registered_vk: VK, proof_vk: VK,
    minimum: '1000', public_balance: '1460', expiry_block: '8430000', current_block: '8420000',
    recipient: ADDR, condition_recipient: ADDR,
    amount: '500', max_transfer: '1000', proof_tx: '0xrestartproof1',
  }, overrides);
}

if (mode === 'record') {
  const store = createSeenStore({ filePath: file, persist: true });
  const r = decide(base(), store);
  if (r.decision !== 'APPROVE' || r.reason_code !== 'VALID_CONDITION') {
    console.error('record: unexpected decision', r);
    process.exit(1);
  }
  console.log(`recorded proof_tx 0xrestartproof1 under gk_restart_1 (store size ${store.size()})`);
  process.exit(0);
}

if (mode === 'check') {
  const store = createSeenStore({ filePath: file, persist: true });
  // 1. The record survived the restart.
  const prev = store.get('0xrestartproof1');
  if (prev !== 'gk_restart_1') { console.error('check: record lost after restart, got', prev); process.exit(1); }
  console.log('PASS  record survived restart (0xrestartproof1 -> gk_restart_1)');
  // 2. Reuse under a different task_id is still detected.
  const reuse = decide(base({ task_id: 'gk_restart_2' }), store);
  if (reuse.decision !== 'REJECT' || reuse.reason_code !== 'PROOF_REUSED') {
    console.error('check: reuse NOT detected after restart', reuse);
    process.exit(1);
  }
  console.log('PASS  PROOF_REUSED still detected after restart');
  // 3. Same task_id retry is still not a reuse.
  const retry = decide(base({ task_id: 'gk_restart_1' }), store);
  if (retry.decision !== 'APPROVE') { console.error('check: same-task retry wrongly flagged', retry); process.exit(1); }
  console.log('PASS  same task_id retry is not reuse after restart');
  // 4. Malformed-line tolerance: append garbage, reload in a fresh store.
  fs.appendFileSync(file, 'this is not json\n{"tx":123}\n');
  const store2 = createSeenStore({ filePath: file, persist: true });
  if (store2.get('0xrestartproof1') !== 'gk_restart_1' || store2.size() !== 1) {
    console.error('check: malformed lines broke reload, size', store2.size());
    process.exit(1);
  }
  console.log('PASS  malformed lines skipped on reload');
  process.exit(0);
}

console.error('unknown mode:', mode);
process.exit(2);
