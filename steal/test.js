// Steal the VFY local test harness — validates the policy function against the
// circuit itself over a grid of states and strategy params, and checks the
// publicInputsHash formula against the documented field order.
// A case passes only if policy() returns the action the circuit accepts
// (witness calc succeeds for that action and fails for the others) AND a
// full Groth16 proof for it verifies locally.
// Run:  node steal/test.js
const { policy, validateParams } = require('./policy');
const { proveTurn, publicInputsHash, strategyCommitment } = require('./prove');
const { verifyLocally } = require('../shared/snark');
const { WitnessCalculatorBuilder } = require('circom_runtime');
const fs = require('fs');

const SALT = '0x00000000000000000000000000000001';

async function circuitAccepts(wc, params, state, action) {
  const input = {
    commitment: strategyCommitment(params, SALT),
    matchId: '0x9f4e1b2a00000000000000000000000001',
    turnNumber: '3',
    selfBalance: String(state.selfBalance),
    opponentBalance: String(state.opponentBalance),
    action: String({ HOLD: 0, FORTIFY: 1, EXTRACT: 2 }[action.type]),
    amount: String(action.type === 'EXTRACT' ? action.amount : 0),
    circuitVersion: '1',
    salt: SALT,
    strategyParams: params.map(String),
  };
  try {
    await wc.calculateWitness(input);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const wc = await WitnessCalculatorBuilder(fs.readFileSync(__dirname + '/../circuits/vfy-policy.wasm'));
  const PARAM_SETS = [
    [5, 50, 0, 0, 0, 0, 0, 0],
    [10, 0, 0, 0, 0, 0, 0, 0],
    [3, 100, 20, 0, 0, 0, 0, 0],
    [5, 0, 0, 1, 0, 0, 0, 0], // hold-only mode
  ];
  const STATES = [
    { selfBalance: 100, opponentBalance: 100 },
    { selfBalance: 30, opponentBalance: 100 },
    { selfBalance: 100, opponentBalance: 0 },
    { selfBalance: 100, opponentBalance: 15 },
    { selfBalance: 49, opponentBalance: 200 },
    { selfBalance: 50, opponentBalance: 200 },
    { selfBalance: 0, opponentBalance: 0 },
    { selfBalance: 200, opponentBalance: 5 },
  ];
  let pass = 0, total = 0;
  for (const params of PARAM_SETS) {
    const perr = validateParams(params);
    if (perr) { console.log('FAIL params', params, perr); continue; }
    for (const state of STATES) {
      total++;
      const action = policy(state, params);
      const okPolicy = await circuitAccepts(wc, params, state, action);
      // the other two actions must be rejected by the circuit
      const others = ['HOLD', 'FORTIFY', 'EXTRACT'].filter((t) => t !== action.type);
      let othersRejected = true;
      for (const t of others) {
        const alt = t === 'EXTRACT' ? { type: 'EXTRACT', amount: params[0] } : { type: t };
        if (await circuitAccepts(wc, params, state, alt)) othersRejected = false;
      }
      const ok = okPolicy && othersRejected;
      if (ok) pass++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  params=[${params}] state=self${state.selfBalance}/opp${state.opponentBalance} -> ${action.type}${action.amount ? ' ' + action.amount : ''} (circuit accepts: ${okPolicy}, others rejected: ${othersRejected})`);
    }
  }
  // publicInputsHash: full proof + local verify + hash sanity (deterministic)
  const params = [5, 50, 0, 0, 0, 0, 0, 0];
  const commitment = strategyCommitment(params, SALT);
  const turn = { matchId: '9f4e1b2a-0000-0000-0000-000000000001', turn: 3, state: { selfBalance: '95', opponentBalance: '105' } };
  const action = policy(turn.state, params);
  const t0 = Date.now();
  const { proof, publicSignals, publicInputsHash: h1 } = await proveTurn(turn, action, commitment, SALT, params);
  const verifyOk = await verifyLocally('vfyPolicy', publicSignals, proof);
  const h2 = publicInputsHash({ commitment, matchId: turn.matchId, turn: 3, selfBalance: '95', opponentBalance: '105', action: action.type, amount: action.amount, circuitVersion: 'v1' });
  const hashOk = h1 === h2 && /^0x[0-9a-f]{64}$/.test(h1);
  total++;
  const ok = verifyOk && hashOk;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  fullProve EXTRACT5 + local verify (${Date.now() - t0}ms) verify=${verifyOk} publicInputsHash deterministic=${hashOk} hash=${h1}`);
  console.log(`\n${pass}/${total} steal cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
