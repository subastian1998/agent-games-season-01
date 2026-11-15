// snarkjs wrapper: local Groth16 proof generation + verification.
// The circuits are small (gatekeeper ~0.4s, vfy-policy ~1.8s per proof on this VM),
// well inside the 60s gatekeeper deadline and the ~30s Steal push window.
const path = require('path');
const snarkjs = require('snarkjs');

const CIRCUITS_DIR = path.join(__dirname, '..', 'circuits');

const CIRCUITS = {
  gatekeeper: {
    wasm: path.join(CIRCUITS_DIR, 'gatekeeper.wasm'),
    zkey: path.join(CIRCUITS_DIR, 'gatekeeper_final.zkey'),
  },
  vfyPolicy: {
    wasm: path.join(CIRCUITS_DIR, 'vfy-policy.wasm'),
    zkey: path.join(CIRCUITS_DIR, 'vfy-policy_final.zkey'),
  },
};

const vkCache = {};

async function getVerificationKey(name) {
  if (!vkCache[name]) {
    vkCache[name] = await snarkjs.zKey.exportVerificationKey(CIRCUITS[name].zkey);
  }
  return vkCache[name];
}

// Generate a Groth16 proof. Returns { proof, publicSignals }.
// Throws if the witness calculation fails — that means the inputs violate the
// circuit (e.g. a decision that does not match the circuit's own evaluation).
async function prove(name, input) {
  const { wasm, zkey } = CIRCUITS[name];
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  return { proof, publicSignals };
}

async function verifyLocally(name, publicSignals, proof) {
  const vk = await getVerificationKey(name);
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

module.exports = { CIRCUITS, getVerificationKey, prove, verifyLocally };
