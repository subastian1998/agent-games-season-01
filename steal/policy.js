// Steal the VFY — deterministic policy, reverse-engineered from the official
// vfy-policy circuit (witness-calc probing, 2026-11-15). The circuit is the
// referee: it accepts exactly one action per (state, params) and rejects the
// rest. This function MUST match the circuit — it is validated against the
// circuit by steal/test.js over a state/param grid.
//
// Strategy params (8 field elements, committed as Poseidon(params + salt)):
//   params[0]  extractAmount        — amount stolen on EXTRACT (1..10)
//   params[1]  fortifyThreshold     — FORTIFY while selfBalance < this
//   params[2]  minOpponentBalance   — EXTRACT only while opponentBalance > this
//   params[3]  mode                 — 0 = normal, 1 = always HOLD; >=2 invalid
//   params[4..7] reserved           — MUST be 0 (semantics unmapped; any
//                                     nonzero value makes NO action valid)
//
// Policy (mode 0), in order:
//   1. selfBalance < params[1]            -> FORTIFY
//   2. opponentBalance <= params[2]       -> HOLD   (extract needs opp > p2;
//                                                    opp == 0 always HOLDs)
//   3. otherwise                          -> EXTRACT params[0]
// Policy (mode 1): always HOLD.
// NOTE: FORTIFY is decided by OWN balance only — the circuit does not see
// whether the opponent is fortified (that is not a circuit input).
const ACTIONS = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 };

function validateParams(params) {
  if (!Array.isArray(params) || params.length !== 8) {
    return 'STRATEGY_PARAMS must be exactly 8 numbers';
  }
  const [p0, p1, p2, p3, p4, p5, p6, p7] = params.map((x) => BigInt(x));
  if (p0 < 1n || p0 > 10n) return 'params[0] (extract amount) must be 1..10';
  if (p1 < 0n) return 'params[1] (fortify threshold) must be >= 0';
  if (p2 < 0n) return 'params[2] (min opponent balance) must be >= 0';
  if (p3 !== 0n && p3 !== 1n) return 'params[3] (mode) must be 0 or 1';
  if (p4 !== 0n || p5 !== 0n || p6 !== 0n || p7 !== 0n) {
    return 'params[4..7] must be 0 (reserved)';
  }
  return null;
}

function policy(state, params) {
  // state: { selfBalance, opponentBalance } as BigInt-compatible values.
  // Returns { type: 'HOLD'|'FORTIFY'|'EXTRACT', amount?: number }.
  // (amount is present ONLY for EXTRACT — the platform rejects amount on
  // HOLD/FORTIFY, even as 0.)
  const [p0, p1, p2, p3] = params.map((x) => BigInt(x));
  const self = BigInt(state.selfBalance);
  const opp = BigInt(state.opponentBalance);
  if (p3 === 1n) return { type: 'HOLD' };
  if (self < p1) return { type: 'FORTIFY' };
  if (opp <= p2) return { type: 'HOLD' };
  return { type: 'EXTRACT', amount: Number(p0) };
}

module.exports = { ACTIONS, validateParams, policy };
