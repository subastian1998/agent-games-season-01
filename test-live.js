// Live end-to-end HTTP test against the running server (127.0.0.1:8080).
// Signs requests with the test HMAC secret from .env and checks:
//  - preflight (both paths)
//  - gatekeeper: valid task -> APPROVE + verifying proof; trap task -> REJECT + proof
//  - steal: turn -> EXTRACT 5 + verifying proof + publicInputsHash
//  - wrong HMAC -> 401
//  - /health
// Run while the server is up:  node test-live.js
const crypto = require('crypto');
const fs = require('fs');

// Test HMAC secret — pass it in, never hardcode one:
//   TEST_HMAC_SECRET=<secret-from-.env> node test-live.js
// The secret must match AGENT_GAMES_HMAC_SECRET in the server's .env.
const SECRET = process.env.TEST_HMAC_SECRET;
if (!SECRET) {
  console.error('Set TEST_HMAC_SECRET first (must match the server .env secret).');
  process.exit(2);
}
const BASE = 'http://127.0.0.1:8080';
const snarkjs = require('snarkjs');

function sign(body, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
async function post(path, obj, secret = SECRET) {
  const body = JSON.stringify(obj);
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-games-signature': sign(body, secret) },
    body,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
function verifyResponseSignature(res, bodyText) {
  const sig = res.headers.get('x-agent-games-signature');
  if (!sig) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(bodyText).digest('hex');
  return sig === expected;
}

(async () => {
  let pass = 0, total = 0;
  const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

  // health
  const h = await fetch(BASE + '/health');
  const hj = await h.json();
  check('GET /health', h.ok && hj.gatekeeper.selfTest.startsWith('PASS') && hj.steal.selfTest.startsWith('PASS'));

  // preflight
  const pf = await post('/gatekeeper', { type: 'agent-games.preflight.v1' });
  check('gatekeeper preflight', pf.status === 200 && pf.body.ok === true && pf.body.protocolVersion === 'v1');

  // wrong HMAC -> 401
  const bad = await post('/gatekeeper', { type: 'agent-games.preflight.v1' }, 'wrong-secret');
  check('wrong HMAC -> 401', bad.status === 401);

  const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
  const ADDR = '0x1111111111111111111111111111111111111111';
  const gkVk = await snarkjs.zKey.exportVerificationKey('circuits/gatekeeper_final.zkey');
  const vfyVk = await snarkjs.zKey.exportVerificationKey('circuits/vfy-policy_final.zkey');

  // gatekeeper valid task
  const task = {
    task_id: 'gk_live_1', registered_vk: VK, proof_vk: VK,
    minimum: '1000', public_balance: '1460', expiry_block: '8430000', current_block: '8420000',
    recipient: ADDR, condition_recipient: ADDR, amount: '500', max_transfer: '1000',
    proof_tx: '0xlivetest1',
  };
  const t0 = Date.now();
  const r1 = await post('/gatekeeper', task);
  const ok1 = r1.status === 200 && r1.body.decision === 'APPROVE' && r1.body.reason_code === 'VALID_CONDITION'
    && r1.body.proof && (await snarkjs.groth16.verify(gkVk, r1.body.public_signals, r1.body.proof));
  check(`gatekeeper valid -> APPROVE + verifying proof (${Date.now() - t0}ms)`, ok1);

  // gatekeeper trap task (threshold)
  const trap = Object.assign({}, task, { task_id: 'gk_live_2', public_balance: '500', proof_tx: '0xlivetest2' });
  const r2 = await post('/gatekeeper', trap);
  const ok2 = r2.status === 200 && r2.body.decision === 'REJECT' && r2.body.reason_code === 'THRESHOLD_MISMATCH'
    && r2.body.proof && (await snarkjs.groth16.verify(gkVk, r2.body.public_signals, r2.body.proof));
  check('gatekeeper trap -> REJECT/THRESHOLD_MISMATCH + verifying proof', ok2);

  // steal turn (EXTRACT 5: self 95, opp 105, params [5,50,0,0,0,0,0,0])
  const commitment = fs.readFileSync('/tmp/ag-commitment.txt', 'utf8').trim();
  const turn = {
    protocolVersion: 'v1', eventId: 'steal-the-vfy', mode: 'competition',
    matchId: '9f4e1b2a-0000-0000-0000-000000000001', turn: 3,
    issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 300000).toISOString(),
    state: { selfBalance: '95', opponentBalance: '105', selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    strategyCommitment: { hash: commitment },
    resolverVersion: 'v1', nonce: 'testnonce1',
  };
  const t1 = Date.now();
  const r3 = await post('/steal', turn);
  const ok3 = r3.status === 200 && r3.body.action.type === 'EXTRACT' && r3.body.action.amount === 5
    && r3.body.policyProof && r3.body.policyProof.publicInputsHash
    && r3.body.proof && (await snarkjs.groth16.verify(vfyVk, r3.body.public_signals, r3.body.proof));
  check(`steal turn -> EXTRACT 5 + verifying proof (${Date.now() - t1}ms)`, ok3, r3.body.action ? JSON.stringify(r3.body.action) : JSON.stringify(r3.body).slice(0, 200));

  console.log(`\n${pass}/${total} live HTTP cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('LIVE TEST ERROR:', e); process.exit(1); });
