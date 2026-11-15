// Agent Games Season 01 — HTTP server for BOTH agents (Proof Gatekeeper + Steal the VFY).
// One process, one port, two paths:
//   POST /gatekeeper  — Proof Gatekeeper tasks
//   POST /steal       — Steal the VFY turns
//   GET  /health      — readiness (secret configured? strategy configured? self-tests?)
//   GET  /            — info
//
// Every inbound request is HMAC-verified over the RAW body against
// x-agent-games-signature BEFORE parsing (when AGENT_GAMES_HMAC_SECRET is
// set). Every response is signed the same way. Preflight
// {"type":"agent-games.preflight.v1"} is answered {ok:true, protocolVersion:"v1"}.
//
// Fail closed: Gatekeeper rejects on any uncertainty; Steal answers HOLD
// (without a proof) on any uncertainty. Nothing here ever approves, signs,
// or spends anything — these are game endpoints only. No wallet, no keys.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---- tiny .env loader (no dependency) ----
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env — env vars only */ }
})();

const { verifySignature, signatureFor } = require('./shared/hmac');
const { verifyLocally } = require('./shared/snark');
const { submitProof } = require('./shared/kurier');
const { decide } = require('./gatekeeper/decide');
const { proveTask } = require('./gatekeeper/prove');
const { policy, validateParams } = require('./steal/policy');
const { proveTurn, strategyCommitment } = require('./steal/prove');
const { toHexString } = require('./shared/field');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const HMAC_FORMAT = process.env.AGENT_GAMES_HMAC_FORMAT || 'hex'; // or 'sha256='
const KURIER_API_KEY = process.env.KURIER_API_KEY || '';
const TASK_ID_MODE = process.env.GATEKEEPER_TASK_ID_MODE || 'keccak';

// ---- Steal configuration (env) ----
// STRATEGY_PARAMS: comma-separated 8 numbers, e.g. "5,50,0,0,0,0,0,0".
// STRATEGY_SALT: random hex (never logged, never committed).
// STRATEGY_COMMITMENT: optional override — the hash registered in the dashboard.
//   If unset, it is computed as Poseidon(params + salt) at startup.
let stealParams = null;
let stealSalt = '';
let stealCommitment = '';
let stealReady = false;
let stealStatus = 'not-configured';
(function initSteal() {
  const raw = (process.env.STEAL_STRATEGY_PARAMS || '').trim();
  stealSalt = (process.env.STEAL_STRATEGY_SALT || '').trim();
  if (!raw || !stealSalt) {
    stealStatus = 'not-configured (STEAL_STRATEGY_PARAMS and/or STEAL_STRATEGY_SALT missing — Steal answers HOLD without a proof)';
    return;
  }
  const params = raw.split(',').map((s) => s.trim());
  const err = validateParams(params);
  if (err) {
    stealStatus = 'invalid: ' + err;
    return;
  }
  stealParams = params;
  stealSalt = toHexString(stealSalt);
  try {
    stealCommitment = toHexString((process.env.STEAL_STRATEGY_COMMITMENT || '').trim()) || strategyCommitment(params, stealSalt);
  } catch (e) {
    stealStatus = 'invalid: commitment failed — ' + e.message;
    return;
  }
  stealReady = true;
  stealStatus = 'ready';
})();

let gatekeeperSelfTest = 'pending';
let stealSelfTest = 'pending';

// ---- helpers ----
function sendJson(res, status, obj, sign) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (sign && HMAC_SECRET) headers['x-agent-games-signature'] = signatureFor(HMAC_SECRET, body, HMAC_FORMAT);
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyInbound(rawBody, req) {
  if (!HMAC_SECRET) {
    console.warn('[warn] AGENT_GAMES_HMAC_SECRET is not set — inbound HMAC is NOT verified. Set it before going live.');
    return true;
  }
  const sig = req.headers['x-agent-games-signature'];
  return verifySignature(HMAC_SECRET, rawBody, sig, HMAC_FORMAT);
}

function isPreflight(obj) {
  return obj && obj.type === 'agent-games.preflight.v1';
}

// ---- Gatekeeper handler ----
async function handleGatekeeper(obj) {
  const task = obj.input || obj;
  const required = ['registered_vk', 'proof_vk', 'minimum', 'public_balance', 'expiry_block', 'current_block', 'recipient', 'condition_recipient', 'amount', 'max_transfer'];
  for (const f of required) {
    if (task[f] === undefined || task[f] === null || task[f] === '') {
      return { status: 200, body: { decision: 'REJECT', reason_code: 'INVALID_TASK', proof_tx: String(task.proof_tx || '') } };
    }
  }
  const { decision, reason_code } = decide(task);
  const proofTx = String(task.proof_tx || '');
  if (reason_code === 'PROOF_REUSED') {
    // No proof to submit for a reused proof (platform excludes these from
    // the reliability bonus).
    return { status: 200, body: { decision, reason_code, proof_tx: proofTx } };
  }
  try {
    const { proof, publicSignals } = await proveTask(task, decision, TASK_ID_MODE);
    // Kurier (best-effort, background): on-chain finalization pointer.
    // Gatekeeper responses carry no proofReference field, so this is fire-and-forget.
    if (KURIER_API_KEY) {
      submitProof(KURIER_API_KEY, 'gatekeeper', proof, publicSignals, 15000).catch(() => {});
    }
    return { status: 200, body: { decision, reason_code, proof_tx: proofTx, proof, public_signals: publicSignals } };
  } catch (e) {
    console.error('[gatekeeper] proof generation failed (decision still returned):', e.message);
    return { status: 200, body: { decision, reason_code, proof_tx: proofTx } };
  }
}

// ---- Steal handler ----
async function handleSteal(obj) {
  const matchId = obj.matchId || '';
  const turn = obj.turn;
  const state = obj.state || {};
  const envelopeCommitment = obj.strategyCommitment && obj.strategyCommitment.hash;
  const holdResponse = (withProof) => {
    const body = { matchId, turn, action: { type: 'HOLD' }, agentTimestamp: new Date().toISOString(), idempotencyKey: crypto.randomUUID() };
    if (withProof) {
      body.policyProof = withProof.policyProof;
      body.proof = withProof.proof;
      body.public_signals = withProof.publicSignals;
    } else {
      body.policyProof = { circuitVersion: 'v1' };
    }
    return { status: 200, body };
  };

  if (!matchId || turn === undefined || turn === null || state.selfBalance === undefined || state.opponentBalance === undefined) {
    return { status: 400, body: { error: 'malformed turn envelope' } };
  }
  if (!stealReady) {
    console.warn('[steal] strategy not configured — answering HOLD without a proof');
    return holdResponse(null);
  }
  if (envelopeCommitment && String(envelopeCommitment).toLowerCase() !== stealCommitment.toLowerCase()) {
    console.error('[steal] envelope commitment does not match registered commitment — answering HOLD');
    return holdResponse(null);
  }
  const action = policy(
    { selfBalance: BigInt(state.selfBalance), opponentBalance: BigInt(state.opponentBalance) },
    stealParams
  );
  try {
    const { proof, publicSignals, publicInputsHash } = await proveTurn(
      { matchId, turn, state }, action, stealCommitment, stealSalt, stealParams
    );
    // Kurier (best-effort, short wait): proofReference for the response.
    let proofReference;
    if (KURIER_API_KEY) {
      const k = await submitProof(KURIER_API_KEY, 'vfyPolicy', proof, publicSignals, 12000);
      if (k) proofReference = k.proofReference;
    }
    const policyProof = { circuitVersion: 'v1', publicInputsHash };
    if (proofReference) policyProof.proofReference = proofReference;
    const actionOut = { type: action.type };
    if (action.type === 'EXTRACT') actionOut.amount = action.amount;
    return {
      status: 200,
      body: {
        matchId, turn, action: actionOut, policyProof,
        proof, public_signals: publicSignals,
        agentTimestamp: new Date().toISOString(),
        idempotencyKey: crypto.randomUUID(),
      },
    };
  } catch (e) {
    console.error('[steal] proof generation failed (answering HOLD):', e.message);
    return holdResponse(null);
  }
}

// ---- startup self-tests (prove the circuits work before serving) ----
async function selfTests() {
  try {
    const task = {
      task_id: 'gk_selftest_1', registered_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
      proof_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
      minimum: '1000', public_balance: '1460', expiry_block: '8430000', current_block: '8420000',
      recipient: '0x1111111111111111111111111111111111111111',
      condition_recipient: '0x1111111111111111111111111111111111111111',
      amount: '500', max_transfer: '1000', proof_tx: '0xselftest',
    };
    const { decision } = decide(task);
    const { proof, publicSignals } = await proveTask(task, decision, TASK_ID_MODE);
    const ok = await verifyLocally('gatekeeper', publicSignals, proof);
    gatekeeperSelfTest = ok && decision === 'APPROVE' ? 'PASS (APPROVE proof verifies locally)' : 'FAIL';
  } catch (e) {
    gatekeeperSelfTest = 'FAIL: ' + e.message;
  }
  try {
    if (!stealReady) {
      stealSelfTest = 'SKIPPED (strategy not configured)';
      return;
    }
    const { proof, publicSignals } = await proveTurn(
      { matchId: '9f4e1b2a-0000-0000-0000-000000000001', turn: 3, state: { selfBalance: '95', opponentBalance: '105' } },
      { type: 'EXTRACT', amount: Number(stealParams[0]) },
      stealCommitment, stealSalt, stealParams
    );
    const ok = await verifyLocally('vfyPolicy', publicSignals, proof);
    stealSelfTest = ok ? 'PASS (EXTRACT proof verifies locally)' : 'FAIL';
  } catch (e) {
    stealSelfTest = 'FAIL: ' + e.message;
  }
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        gatekeeper: { hmacConfigured: !!HMAC_SECRET, taskIdMode: TASK_ID_MODE, selfTest: gatekeeperSelfTest },
        steal: { status: stealStatus, selfTest: stealSelfTest, kurierConfigured: !!KURIER_API_KEY },
        uptimeSec: Math.floor(process.uptime()),
      });
    }
    if (req.method === 'GET' && req.url === '/') {
      return sendJson(res, 200, { service: 'agent-games', tracks: ['proof-gatekeeper', 'steal-the-vfy'], endpoints: ['POST /gatekeeper', 'POST /steal', 'GET /health'] });
    }
    if (req.method !== 'POST' || (req.url !== '/gatekeeper' && req.url !== '/steal')) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const rawBody = await readBody(req);
    if (!verifyInbound(rawBody, req)) {
      console.warn('[warn] HMAC mismatch on', req.url);
      return sendJson(res, 401, { error: 'bad signature' });
    }
    let obj;
    try {
      obj = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    if (isPreflight(obj)) {
      return sendJson(res, 200, { ok: true, protocolVersion: 'v1' }, true);
    }
    const result = req.url === '/gatekeeper' ? await handleGatekeeper(obj) : await handleSteal(obj);
    return sendJson(res, result.status, result.body, true);
  } catch (e) {
    console.error('[server] unhandled error:', e);
    return sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`[server] listening on ${HOST}:${PORT}  (gatekeeper: /gatekeeper, steal: /steal)`);
  console.log(`[server] HMAC secret: ${HMAC_SECRET ? 'configured' : 'NOT SET (inbound verification disabled)'}`);
  console.log(`[server] Steal: ${stealStatus}`);
  console.log(`[server] Kurier: ${KURIER_API_KEY ? 'configured' : 'not configured (local proofs only)'}`);
  await selfTests();
  console.log(`[server] self-test gatekeeper: ${gatekeeperSelfTest}`);
  console.log(`[server] self-test steal: ${stealSelfTest}`);
});
