# Agent Games — Season 01

Two competition agents for the **zkVerify Agent Games** tournament
(21 Oct – 21 Nov 2026, 400,000 VFY total, 100,000 VFY per track).
Account: **@rday98**, wallet `0x6865061eDE3F4E7d19d3325F52690C69dB576D3c`
(wallet #3 — this code never touches any wallet, key, or seed).

| Agent | Endpoint | What it does |
|---|---|---|
| **Proof Gatekeeper** | `POST /gatekeeper` | Decides APPROVE/REJECT on transfer tasks with a Groth16 ZK proof (7-trap checklist; the circuit is the referee) |
| **Steal the VFY** | `POST /steal` | Plays 1v1 Swiss turns (HOLD / FORTIFY / EXTRACT) with a Groth16 policy proof for the pre-committed strategy |

Both agents live in one Node.js server (`server.js`, no framework, plain `http`).
Proofs are generated **locally** with snarkjs and the official circuits; Kurier
is an optional best-effort on-chain finalization step (see below).

## Quick start

```bash
npm install              # install dependencies (see package.json)
cp .env.example .env   # fill in the values (see "Configuration")
node server.js         # or: ./start.sh
# with a public tunnel (needed for the platform to reach the endpoint):
./start.sh tunnel
```

Node 22+ is required.

```bash
# tests (validate the decision/policy logic against the circuits themselves)
node gatekeeper/test.js
node steal/test.js
```

## Configuration (`.env`)

| Variable | Required | What it is |
|---|---|---|
| `PORT` | no (8080) | Local port the server listens on |
| `AGENT_GAMES_HMAC_SECRET` | **yes, before going live** | From the dashboard "Rotate Secret". Without it, inbound HMAC verification is disabled (health shows it) |
| `AGENT_GAMES_HMAC_FORMAT` | no (`hex`) | `hex` or `sha256=` — switch if the platform rejects the preflight |
| `GATEKEEPER_TASK_ID_MODE` | no (`keccak`) | How `task_id` maps to the circuit field element: `keccak` (default), `numeric`, `hex` — confirm in practice |
| `KURIER_API_KEY` | no | Free key from https://kurier.xyz (email signup). Optional — responses always carry the local proof |
| `STEAL_STRATEGY_PARAMS` | yes, for Steal proofs | 8 comma-separated numbers, e.g. `5,50,0,0,0,0,0,0` |
| `STEAL_STRATEGY_SALT` | yes, for Steal proofs | Random hex (`openssl rand -hex 16`). Never log/share/commit |
| `STEAL_STRATEGY_COMMITMENT` | no | Hash registered in the dashboard; computed as Poseidon(params + salt) if blank |

## Gatekeeper — how it works

The platform POSTs a signed task envelope (`task_id`, `registered_vk`,
`proof_vk`, `minimum`, `public_balance`, `expiry_block`, `current_block`,
`recipient`, `condition_recipient`, `amount`, `max_transfer`, `proof_tx`).
The server verifies the HMAC over the raw body, then applies the deterministic
7-trap checklist (first failing trap wins):

- `VK_SUBSTITUTION` — `proof_vk != registered_vk`
- `PROOF_REUSED` — `proof_tx` already seen under a *different* `task_id`
  (a retry of the same `task_id` is not a reuse)
- `THRESHOLD_MISMATCH` — `public_balance < minimum`
- `EXPIRED_CONDITION` — `current_block > expiry_block`
- `RECIPIENT_MISMATCH` — `recipient != condition_recipient`
- `AMOUNT_OVERFLOW` — `amount > max_transfer`
- else `VALID_CONDITION` → APPROVE

Boundaries are inclusive for balance and amount — but **strict for expiry**
(verified against the circuit): `balance == minimum` and `amount == max`
are VALID, while `current_block == expiry_block` is EXPIRED (valid only
while `current_block < expiry_block`). The circuit enforces
that the decision matches its own evaluation — a wrong decision fails witness
generation, so the agent cannot fake a decision (and the server returns the
decision without a proof rather than crashing if proof generation ever fails).

Response (signed with `x-agent-games-signature` over the raw body):

```json
{"decision": "APPROVE", "reason_code": "VALID_CONDITION", "proof_tx": "0x…",
 "proof": {"pi_a": […], "pi_b": […], "pi_c": […], "protocol": "groth16", "curve": "bn128"},
 "public_signals": ["…13 values…"]}
```

`PROOF_REUSED` responses carry no proof (the platform excludes them from the
reliability bonus). Preflight (`{"type":"agent-games.preflight.v1"}`) is
answered `{ok:true, protocolVersion:"v1"}`, signed.

Scoring: correct +12, wrong APPROVE −6, wrong REJECT −3, timeout −2,
missing/invalid proof −2, reliability bonus +0..+5. Rounds: 8 daily rounds,
13–21 Nov, 17:30–03:30 WIB, 8 tasks/agent/round. Proof generation ~0.4s,
far inside the 60s deadline.

**Open item — `taskId` mapping.** The envelope's `task_id` is a string
(e.g. `gk_24_9d1`); the circuit needs a field element. Default:
`keccak256(task_id)` mod field prime. Alternatives: `numeric` (digits of the
suffix), `hex` (hex chars of the suffix). The mapping is one function in
`gatekeeper/prove.js` — confirm it against a practice task and switch
`GATEKEEPER_TASK_ID_MODE` if the platform rejects the proof.

## Steal the VFY — how it works

The platform POSTs a signed turn envelope (`matchId`, `turn`, `state`
`{selfBalance, opponentBalance, selfFortifiedUntilTurn,
opponentFortifiedUntilTurn}`, `strategyCommitment.hash`, …). The server
answers with the action dictated by the **pre-committed strategy** plus a
Groth16 policy proof that the action follows that strategy.

### Strategy parameters (verified against the official circuit)

`strategyParams[0..7]`, committed as `Poseidon(params + salt)`:

| Param | Meaning (reverse-engineered from the circuit) |
|---|---|
| `params[0]` | extract amount on EXTRACT (1–10) |
| `params[1]` | fortify threshold — FORTIFY while `selfBalance < params[1]` |
| `params[2]` | min opponent balance — EXTRACT only while `opponentBalance > params[2]` |
| `params[3]` | mode: `0` = normal, `1` = always HOLD; `>= 2` invalid |
| `params[4..7]` | reserved — **must be 0** (semantics unmapped; any nonzero value makes no action valid) |

Policy (mode 0), in order: `self < params[1]` → FORTIFY;
`opponent <= params[2]` → HOLD; otherwise → EXTRACT `params[0]`.
Mode 1 always HOLDs. FORTIFY is decided by **own** balance only — the circuit
does not see whether the opponent is fortified.

### Proposed default strategy (needs the user's approval)

```
STEAL_STRATEGY_PARAMS="5,50,0,0,0,0,0,0"
```

Extract 5 per turn, fortify while own balance is below 50, extract whenever
the opponent has anything. Conservative, middle-of-the-road. The server ships
with the strategy as a TODO per the official starter prompt — **no strategy
is hardcoded**: if `STEAL_STRATEGY_PARAMS` / `STEAL_STRATEGY_SALT` are unset,
the server answers HOLD without a proof (fail closed). Set the values in
`.env`, then register the commitment:

```bash
node steal/commitment.js   # prints ONLY the commitment hash — never the params/salt
```

Register that hash in the dashboard **before Swiss pairing**; it is frozen
once matches are paired. The server checks the envelope's
`strategyCommitment.hash` against the registered commitment on every turn
and answers HOLD (no proof) on a mismatch.

Response (signed):

```json
{"matchId": "…", "turn": 3, "action": {"type": "EXTRACT", "amount": 5},
 "policyProof": {"circuitVersion": "v1", "proofReference": "0x…", "publicInputsHash": "0x…"},
 "proof": {…}, "public_signals": ["…9 values…"],
 "agentTimestamp": "…", "idempotencyKey": "…"}
```

`action.amount` is omitted entirely for HOLD/FORTIFY (the platform rejects
it even as 0). `publicInputsHash` is keccak256 of the ABI-packed fields in
the documented order (commitment, matchId, turn, selfBalance, opponentBalance,
action, amount, circuitVersion). `proofReference` is the Kurier tx hash (or
job ID while finalizing); it is omitted when Kurier is not configured.
Proof generation ~1.8s, inside the ~30s push window.

**Late entry:** Swiss Round 1 opened 13 Nov and the docs say entries lock
once the tournament is paired ("Not committing a strategy before Swiss Round 1
opens — the platform cannot pair you"). Late entry for the remaining rounds
is therefore **likely closed** — confirm in the dashboard; if it lets you
commit a strategy now, this agent is ready to play.

## Kurier (optional, best-effort)

Kurier (`https://api.kurier.xyz/api/v1`) submits proofs for on-chain
finalization on zkVerify. API key is **free** (email signup at
https://kurier.xyz). The server registers each circuit's VK once
(`register-vk`), submits each proof (`submit-proof`), and polls `job-status`
until Finalized (bounded wait: 20s gatekeeper / 12s steal). If Kurier is
unconfigured, slow, or fails, the response still carries the local proof —
Kurier never blocks or breaks a response.

## Dashboard steps (user, in the browser)

1. **Register** (if not done): https://agentgames.zkverify.io/dashboard —
   handle `@rday98`, wallet `0x6865061eDE3F4E7d19d3325F52690C69dB576D3c`.
2. **Endpoints:** register `https://<tunnel-url>/gatekeeper` and
   `https://<tunnel-url>/steal` (HTTPS, full handler path).
3. **Rotate Secret** → paste into `.env` as `AGENT_GAMES_HMAC_SECRET`, restart.
4. **Preflight + practice task** for Gatekeeper (confirms the HMAC format
   and the `taskId` mapping — see "Open item" above).
5. **Steal strategy:** approve the proposed params (or give your own),
   run `node steal/commitment.js`, register the hash in the dashboard,
   set `STEAL_STRATEGY_PARAMS` / `STEAL_STRATEGY_SALT` in `.env`, restart.
   Confirm whether late entry is still accepted.
6. **Kurier (optional):** sign up at https://kurier.xyz, paste the key as
   `KURIER_API_KEY`, restart.

## Health & restart

- `GET /health` — HMAC configured? Steal status? Self-test results?
  (The server runs a proof self-test at startup: a valid APPROVE proof and,
  when the strategy is configured, an EXTRACT proof, each verified locally.)
- **Public URL — hosting caveat (measured 2026-11-15):** this VM's egress
  proxy blocks the free tunnels — tunnelmole's service endpoint returns 502
  through the proxy (its client also ignores proxy env vars and tries direct
  egress, which is blocked) and `api.trycloudflare.com` returns 403.
  So `./start.sh tunnel` does **not** produce a working public URL from this
  VM. The server itself is fully working (see live-test results below); run
  it where egress is unrestricted — your own PC/VPS, or another environment
  — and register that host's public URL. A named Cloudflare Tunnel with your
  own account is the other option (untested here; the same proxy may block
  it). The repo keeps the tunnelmole install (`tunnel/`) and the cloudflared
  binary for use on an unrestricted host.
- VM restarts kill background processes — re-run `start.sh` (a random tunnel
  URL changes on restart; re-register it in the dashboard).
- Logs: the server logs decisions, proof timings, and errors to stdout.
  **Secrets (HMAC secret, strategy salt/params, Kurier key) are never logged.**

## Files

```
server.js                  entry point (both agents, one port)
gatekeeper/decide.js       7-trap checklist (+ proof_tx seen-set)
gatekeeper/prove.js        circuit input mapping, taskId mapping
gatekeeper/test.js         harness: all 7 traps + boundaries vs the circuit
steal/policy.js            deterministic policy (matches the circuit exactly)
steal/prove.js             circuit input mapping + publicInputsHash
steal/commitment.js        prints the Poseidon commitment hash to register
steal/test.js              harness: policy grid + full proof vs the circuit
shared/field.js            field arithmetic, keccak, Poseidon commitment
shared/hmac.js             HMAC-SHA256 verify/sign
shared/snark.js            snarkjs wrapper (prove / verify)
shared/kurier.js           Kurier submission (optional, best-effort)
shared/test-gatekeeper-proof.js / probe-*.js   research scripts (not needed at runtime)
circuits/                  official wasm + zkey (gatekeeper, vfy-policy)
tunnel/                    tunnelmole install (public URL)
```

## Verification notes (what was actually measured, 2026-11-15)

- Gatekeeper `groth16.fullProve` + `groth16.verify` OK on a valid scenario
  (~0.4s) and on a REJECT scenario (~0.4s); `nPublic=13`; a wrong decision
  fails witness generation at the circuit (line 102 assert) — the circuit is
  the referee.
- vfy-policy `groth16.fullProve` + `verify` OK on an EXTRACT scenario
  (~1.8s); `nPublic=9`; 17 circuit inputs found by probing the wasm
  (commitment, matchId, turnNumber, selfBalance, opponentBalance, action,
  amount, circuitVersion, salt, strategyParams[8]); commitment =
  Poseidon(params + salt) confirmed by witness-calc grid (only that ordering
  passes); policy semantics mapped by a state/param sweep (see `steal/policy.js`).
- `publicInputsHash` formula: keccak256 of the 8 ABI-packed fields in the
  documented order (it is an off-circuit audit value, not a circuit signal —
  the circuit's first public signal is a salt-dependent binding hash).
- HMAC format is the standard assumption (hex HMAC-SHA256 over the raw body);
  the docs do not state it explicitly — preflight is the verification step.
- **Live HTTP test (2026-11-15, `test-live.js`, server on 127.0.0.1:8080):
  6/6 passed** — `/health` (both self-tests PASS), gatekeeper preflight,
  wrong HMAC → 401, valid task → APPROVE + locally-verifying proof (535ms),
  trap task → REJECT/THRESHOLD_MISMATCH + verifying proof, steal turn →
  EXTRACT 5 + verifying proof (818ms).
- **Gatekeeper harness: 12/12** (`gatekeeper/test.js`) — all 7 trap types,
  boundaries (balance == minimum and amount == max are VALID; expiry is
  STRICT: `current == expiry` is EXPIRED), proof-reuse detection, same-task
  retry is not a reuse. **Steal harness: 33/33** (`steal/test.js`) — policy
  matches the circuit on 4 param sets × 8 states, plus full proof + hash.
- No money was spent: no Kurier account, no VFY bought, no funded account.
  Kurier's API key is free/self-serve.
