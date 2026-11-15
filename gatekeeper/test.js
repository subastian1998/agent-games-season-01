// Gatekeeper local test harness — replays sample envelopes for ALL 7 trap types
// plus boundary cases, and checks the decision against the circuit itself:
// for each case the harness builds the proof with the harness's decision and
// verifies it locally. A case passes only if (a) decide() returns the
// expected decision/reason_code AND (b) the circuit accepts the proof.
// Run:  node gatekeeper/test.js
const { decide, resetSeen } = require('./decide');
const { proveTask } = require('./prove');
const { verifyLocally } = require('../shared/snark');

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const OTHER_VK = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR = '0x1111111111111111111111111111111111111111';
const OTHER_ADDR = '0x2222222222222222222222222222222222222222';

function base(overrides = {}) {
  return Object.assign({
    task_id: 'gk_test_1', registered_vk: VK, proof_vk: VK,
    minimum: '1000', public_balance: '1460', expiry_block: '8430000', current_block: '8420000',
    recipient: ADDR, condition_recipient: ADDR,
    amount: '500', max_transfer: '1000', proof_tx: '0xtestproof1',
  }, overrides);
}

const CASES = [
  ['VALID_CONDITION (APPROVE)', base(), 'APPROVE', 'VALID_CONDITION'],
  ['VK_SUBSTITUTION', base({ proof_vk: OTHER_VK, proof_tx: '0xtestproof2' }), 'REJECT', 'VK_SUBSTITUTION'],
  ['THRESHOLD_MISMATCH (balance 999 < 1000)', base({ public_balance: '999', proof_tx: '0xtestproof3' }), 'REJECT', 'THRESHOLD_MISMATCH'],
  ['EXPIRED_CONDITION (current 8430001 > expiry 8430000)', base({ current_block: '8430001', proof_tx: '0xtestproof4' }), 'REJECT', 'EXPIRED_CONDITION'],
  ['RECIPIENT_MISMATCH', base({ recipient: OTHER_ADDR, proof_tx: '0xtestproof5' }), 'REJECT', 'RECIPIENT_MISMATCH'],
  ['AMOUNT_OVERFLOW (1500 > 1000)', base({ amount: '1500', proof_tx: '0xtestproof6' }), 'REJECT', 'AMOUNT_OVERFLOW'],
  // boundaries (inclusive except expiry, which is strict)
  ['boundary: balance == minimum (1000)', base({ public_balance: '1000', proof_tx: '0xtestproof7' }), 'APPROVE', 'VALID_CONDITION'],
  ['boundary: current == expiry (8430000) -> EXPIRED (strict)', base({ current_block: '8430000', proof_tx: '0xtestproof8' }), 'REJECT', 'EXPIRED_CONDITION'],
  ['boundary: current == expiry - 1 (8429999)', base({ current_block: '8429999', proof_tx: '0xtestproof8b' }), 'APPROVE', 'VALID_CONDITION'],
  ['boundary: amount == max (1000)', base({ amount: '1000', proof_tx: '0xtestproof9' }), 'APPROVE', 'VALID_CONDITION'],
];

(async () => {
  resetSeen();
  let pass = 0;
  for (const [name, task, wantDecision, wantReason] of CASES) {
    const t0 = Date.now();
    const got = decide(task);
    const decisionOk = got.decision === wantDecision && got.reason_code === wantReason;
    let proofOk = false;
    let proofMs = 0;
    try {
      const { proof, publicSignals } = await proveTask(task, got.decision, process.env.GATEKEEPER_TASK_ID_MODE || 'keccak');
      proofMs = Date.now() - t0;
      proofOk = await verifyLocally('gatekeeper', publicSignals, proof);
    } catch (e) {
      proofOk = false;
    }
    const ok = decisionOk && proofOk;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  decision=${got.decision}/${got.reason_code} (want ${wantDecision}/${wantReason})  proof=${proofOk ? 'verify OK' : 'FAIL'}  ${proofMs}ms`);
  }
  // PROOF_REUSED: same proof_tx, different task_id (after the valid case used 0xtestproof1)
  const reuse = base({ task_id: 'gk_test_99', proof_tx: '0xtestproof1' });
  const r = decide(reuse);
  const reuseOk = r.decision === 'REJECT' && r.reason_code === 'PROOF_REUSED';
  if (reuseOk) pass++;
  console.log(`${reuseOk ? 'PASS' : 'FAIL'}  PROOF_REUSED (same proof_tx, other task_id)  decision=${r.decision}/${r.reason_code}`);
  // same task_id retry is NOT a reuse
  const retry = base({ task_id: 'gk_test_1', proof_tx: '0xtestproof1' });
  const r2 = decide(retry);
  const retryOk = r2.decision === 'APPROVE';
  if (retryOk) pass++;
  console.log(`${retryOk ? 'PASS' : 'FAIL'}  same task_id retry is not reuse  decision=${r2.decision}/${r2.reason_code}`);

  console.log(`\n${pass}/${CASES.length + 2} gatekeeper cases passed`);
  process.exit(pass === CASES.length + 2 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
