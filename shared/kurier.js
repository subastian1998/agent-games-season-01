// Kurier (zkVerify) proof submission — OPTIONAL, best-effort.
// The platform accepts the locally-generated Groth16 proof in the response
// (that is the primary evidence). Kurier adds an on-chain finalization
// pointer (proofReference) for the response. If no KURIER_API_KEY is set,
// or Kurier is slow/down, the server still responds with the local proof —
// Kurier never blocks or breaks a response.
//
// Flow (official zkVerify docs, https://docs.zkverify.io/overview/getting-started/kurier):
//   1. POST {API}/register-vk/{apiKey}  { proofType:'groth16',
//      proofOptions:{library:'snarkjs',curve:'bn128'}, vk }  -> { vkHash }
//      (once per circuit; cached in memory and in kurier-vk.json)
//   2. POST {API}/submit-proof/{apiKey} { proofType:'groth16', vkRegistered:true,
//      proofOptions:{...}, proofData:{ proof, publicSignals, vk: vkHash } }
//      -> { jobId, optimisticVerify }
//   3. GET  {API}/job-status/{apiKey}/{jobId} -> { status, txHash }
//      Poll until "Finalized" (or the caller's deadline).
// API key: free, self-serve — sign up at https://kurier.xyz (email).
// No payment is involved for an API key.
const fs = require('fs');
const path = require('path');
const { getVerificationKey } = require('./snark');

const API_URL = process.env.KURIER_API_URL || 'https://api.kurier.xyz/api/v1';
const CACHE_FILE = path.join(__dirname, '..', 'kurier-vk.json');

let vkHashCache = {};
try {
  vkHashCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch { /* no cache yet */ }

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(vkHashCache, null, 2));
  } catch (e) {
    console.error('[kurier] could not save vk cache:', e.message);
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kurier ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kurier ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function registerVk(apiKey, circuitName) {
  if (vkHashCache[circuitName]) return vkHashCache[circuitName];
  const vk = await getVerificationKey(circuitName);
  const data = await postJson(`${API_URL}/register-vk/${apiKey}`, {
    proofType: 'groth16',
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
    vk,
  });
  const vkHash = data.vkHash || (data.meta && data.meta.vkHash);
  if (!vkHash) throw new Error('register-vk returned no vkHash: ' + JSON.stringify(data).slice(0, 300));
  vkHashCache[circuitName] = vkHash;
  saveCache();
  return vkHash;
}

// Submit a proof and wait (up to waitMs) for Finalized.
// Returns { jobId, txHash|null, proofReference } or null on any failure.
// proofReference is the txHash once finalized, else the jobId (both point at
// the Kurier job; the platform can resolve either).
async function submitProof(apiKey, circuitName, proof, publicSignals, waitMs) {
  if (!apiKey) return null;
  try {
    const vkHash = await registerVk(apiKey, circuitName);
    const submitted = await postJson(`${API_URL}/submit-proof/${apiKey}`, {
      proofType: 'groth16',
      vkRegistered: true,
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      proofData: { proof, publicSignals, vk: vkHash },
    });
    const jobId = submitted.jobId;
    if (!jobId) return null;
    if (submitted.optimisticVerify !== 'success') {
      console.error('[kurier] optimisticVerify not success:', JSON.stringify(submitted).slice(0, 300));
      return { jobId, txHash: null, proofReference: jobId };
    }
    const deadline = Date.now() + (waitMs || 20000);
    while (Date.now() < deadline) {
      const st = await getJson(`${API_URL}/job-status/${apiKey}/${jobId}`);
      if (st.status === 'Finalized') {
        return { jobId, txHash: st.txHash || null, proofReference: st.txHash || jobId };
      }
      if (st.status === 'Failed') {
        console.error('[kurier] job failed:', JSON.stringify(st).slice(0, 300));
        return { jobId, txHash: null, proofReference: jobId };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { jobId, txHash: null, proofReference: jobId };
  } catch (e) {
    console.error('[kurier] submission error (continuing with local proof):', e.message);
    return null;
  }
}

module.exports = { registerVk, submitProof, API_URL };
