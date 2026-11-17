// Gatekeeper restart-persistence harness.
// Spawns REAL separate node processes so a genuine process restart is
// exercised: process 1 records a proof_tx and exits; process 2 starts
// fresh, reloads the store from disk, and must still detect PROOF_REUSED.
// Run:  node gatekeeper/test-restart.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE = process.execPath;
const WORKER = path.join(__dirname, 'test-restart-worker.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-restart-'));
const seenFile = path.join(tmpDir, 'seen-proof-tx.jsonl');

function run(mode) {
  return execFileSync(NODE, [WORKER, mode, seenFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    const out = fn();
    pass++;
    console.log(`PASS  ${name}`);
    if (out) process.stdout.write(out.split('\n').filter(Boolean).map((l) => `      ${l}\n`).join(''));
  } catch (e) {
    console.log(`FAIL  ${name}`);
    const detail = String((e.stdout || '') + (e.stderr || '') + e.message);
    console.log(detail.split('\n').filter(Boolean).map((l) => `      ${l}`).join('\n'));
  }
}

check('process 1 records proof_tx and exits', () => run('record'));
check('process 2 (fresh) still detects PROOF_REUSED + retry semantics + malformed-line tolerance', () => run('check'));
check('seen file contains exactly one record line for the proof_tx', () => {
  const lines = fs.readFileSync(seenFile, 'utf8').split('\n').filter(Boolean);
  const recs = lines.filter((l) => {
    try { return JSON.parse(l).tx === '0xrestartproof1'; } catch { return false; }
  });
  if (recs.length !== 1) throw new Error(`expected 1 record line, got ${recs.length} of ${lines.length} lines`);
  return `seen file: ${lines.length} lines total (1 record + 2 malformed), 1 valid record\n`;
});

console.log(`\n${pass}/${total} restart-persistence cases passed`);
process.exit(pass === total ? 0 : 1);
