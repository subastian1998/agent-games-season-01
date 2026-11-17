# Agent Games — Proof Gatekeeper UPGRADE v2 ("versi tercanggih")

**Tanggal:** 2026-11-18 (dikerjakan 01:29–~02:00 WIB)
**Status: SELESAI DIBANGUN + SEMUA TEST HIJAU — BELUM DI-DEPLOY** (deploy butuh
langkah manual di bawah; jangan deploy di luar jendela aman)
**Target:** maksimalkan skor di Round 06/07/08 (18–20 Nov) untuk kejar Top 1.
**Prinsip:** semantik keputusan TIDAK DIUBAH — checklist 7-trap sama persis
dengan circuit. Yang diperbaiki hanya reliabilitas di sekitarnya (tidak ada
poin yang hilang karena restart, hang, atau input malformed).

---

## 1. Celah yang ditemukan (audit v1)

### Celah 1 — KRITIS: `seenProofTx` in-memory, hilang saat restart (SUDAH DIPERBAIKI)
- **Bukti (v1):** `gatekeeper/decide.js`: `const seenProofTx = new Map();` —
  tidak ada penyimpanan ke disk di mana pun. Server Railway sudah uptime
  ~2,4 hari, tapi setiap restart/redeploy/crash me-reset Map ini.
- **Dampak skor:** trap `PROOF_REUSED` (proof_tx sama di task_id berbeda)
  tidak terdeteksi setelah restart → agen APPROVE (atau menilai trap lain)
  padahal jawaban benar adalah `REJECT/PROOF_REUSED`. APPROVE yang salah =
  **−6**, padahal REJECT yang benar = **+12**. Selisih **18 poin per trap
  yang terlewat**. Di ronde 8 tugas, satu trap terlewat saja bisa
  menentukan Top 1 vs Top 3.
- **Bukti nyata dari pengujian:** sebelum v2, restart server = seen-set
  kembali 0 (dikonfirmasi lewat `/health` v1 yang tidak punya field ini
  dan perilaku Map). Setelah v2, restart dengan file yang sama = seen-set
  tetap 3 (lihat §4).

### Celah 2 — SEDANG: proof generation tanpa watchdog (SUDAH DIPERBAIKI)
- **Bukti (v1):** `server.js` `handleGatekeeper` memanggil
  `await proveTask(...)` tanpa timeout apa pun. `proveTask` → snarkjs
  `fullProve` tidak bisa di-cancel. Kalau proof nge-hang (input aneh,
  resource stall), request tidak pernah dijawab → platform timeout = **−2**,
  dan selama itu platform tidak bisa retry (tidak ada respons).
- **Dampak skor:** sama-sama −2 seperti proof-less, tapi respons yang cepat
  memberi platform kesempatan retry task yang sama (retry pakai task_id
  sama = bukan reuse, jadi bisa dapat proof valid di percobaan kedua).
- **Konteks:** proof normal ~0,4 detik; batas platform 60 detik. Watchdog
  30 detik = 75× headroom, praktis tidak akan pernah kena kecuali hang
  sungguhan.

### Celah 3 — SEDANG: `decide()` throw → HTTP 500, tanpa keputusan (SUDAH DIPERBAIKI)
- **Bukti (v1):** `decide()` memanggil `BigInt(input.minimum)` dkk. tanpa
  try/catch. Kalau platform mengirim angka non-numerik (mis. amount
  `"12.5"`, string kosong lolos guard, atau tipe aneh), `BigInt` throw →
  throw naik ke handler HTTP terluar → **500 `{error: 'internal error'}`**
  tanpa decision. Platform mencatatnya sebagai timeout (**−2**) dan tidak
  mendapat jawaban sama sekali.
- **Dampak skor:** −2 per task malformed, plus platform tidak bisa
  membedakan task invalid vs agen down.
- **Verifikasi:** diuji live — task dengan `amount: "12.5"` di v1 akan 500;
  di v2 dijawab `200 REJECT/INVALID_TASK` (lihat §4).

### Celah 4 — RENDAH: `readBody` tanpa batas ukuran (SUDAH DIPERBAIKI)
- **Bukti (v1):** `readBody()` menampung semua chunk tanpa batas. Satu
  request raksasa bisa menghabiskan memori → crash → semua task di ronde
  itu hilang (dan seen-set in-memory ikut hilang — lihat Celah 1).
- **Perbaikan:** batas 1 MB (envelope platform ~1 KB), selebihnya 413.
  Perhatian: implementasi pertama memakai `req.destroy()` — ternyata itu
  membuat klien tidak pernah menerima 413 (koneksi putus duluan; diuji dan
  gagal). Diperbaiki dengan drain-then-413; diuji ulang dan lolos.

### Yang dicek dan TIDAK bermasalah (tidak diubah)
- **Checklist 7-trap + boundary:** sudah benar dan sama dengan circuit
  (`test.js` 12/12 di v1 dan v2). `balance == minimum` VALID,
  `current == expiry` EXPIRED (strict), `amount == max` VALID.
- **HMAC verify/sign:** benar (timingSafeEqual, raw body, preflight OK).
- **taskId mapping keccak:** sudah terverifikasi di practice (15 Nov) — tidak diubah.
- **Concurrency:** `decide()` sinkron, jadi pencatatan seen-set atomik
  terhadap request bersamaan. `fullProve` per-task independen; 8 tugas
  bersamaan ≈ 8 × 0,4 dtk masih jauh di dalam 60 dtk.
- **Kurier:** fire-and-forget, tidak pernah memblokir respons — benar.
- **Steal:** tidak disentuh (track sudah tutup musim ini); `steal/test.js`
  tetap 33/33.
- **Self-test startup:** benar, tapi task self-test memakai proof_tx
  `'0xselftest'` — di v2 dijalankan dengan store transient supaya marker
  itu tidak pernah mengotori file seen-set produksi.

---

## 2. Perubahan yang dibuat (v2)

| File | Perubahan |
|---|---|
| `gatekeeper/seenStore.js` **(BARU, 121 baris)** | Store seen-set persisten: Map in-memory + append-only JSONL (`{"tx","task","ts"}` per baris) + `fsync` per record. Load saat startup (replay file, first-wins). Baris malformed di-skip, tidak pernah fatal. Gagal persist → warning + tetap di memori (request tidak pernah gagal karena store). Path via `GATEKEEPER_SEEN_FILE` (default `gatekeeper/seen-proof-tx.jsonl`), on/off via `GATEKEEPER_SEEN_PERSIST`. |
| `gatekeeper/decide.js` | `seenProofTx` Map diganti store persisten. **Urutan check dan titik pencatatan TIDAK berubah** (VK dulu → catat proof_tx → threshold → expiry → recipient → amount). `decide(input, store?)` — argumen store opsional (default: store proses). Self-test/harness memakai store sendiri. |
| `server.js` | (a) Watchdog proof 30 dtk (`GATEKEEPER_PROVE_TIMEOUT_MS`, default 30000) — timeout → jawab decision-only (bukan hang). (b) `decide()` dibungkus try/catch → task malformed = `REJECT/INVALID_TASK` 200, bukan 500. (c) `readBody` batas 1 MB (`MAX_BODY_BYTES`) → 413 (drain-then-respond, bukan destroy). (d) Log keputusan terstruktur: satu baris JSON per keputusan (`ts, track, task_id, decision, reason_code, proof_tx, proof_ms, proof` — **tanpa secret**: tanpa HMAC, tanpa salt, tanpa isi proof). (e) Self-test pakai store transient. (f) `/health` menampilkan `seenProofTx` + `seenPersisted`. (g) Seen-set di-load eager saat startup + log jumlahnya. |
| `gatekeeper/test.js` | Set `GATEKEEPER_SEEN_PERSIST=0` sebelum require — test proof_tx tidak pernah menyentuh file produksi. Kasus tetap 12, tidak diubah. |
| `gatekeeper/test-restart.js` **(BARU)** + `test-restart-worker.js` **(BARU)** | Harness restart: dua proses node terpisah (record → exit → fresh process reload → verifikasi). Lihat §3. |
| `.gitignore` | Tambah `gatekeeper/seen-proof-tx.jsonl` — state runtime tidak boleh ter-commit. |
| `.env.example` | Dokumentasi 4 env var baru (lihat §5). |
| `README.md` | Paragraf v2 di bagian Gatekeeper + pointer ke laporan ini. |
| `package-lock.json` **(BARU, dari `npm install`)** | Lockfile 37 packages — ikut ter-commit supaya install Railway reproducible. |
| `node_modules/` | Dibuat lokal oleh `npm install` (37 packages, 53 dtk) — tetap gitignored, tidak di-commit. |

**Yang TIDAK diubah:** semantik keputusan, circuit/wasm/zkey, endpoint/URL,
`.env` (tidak disentuh sama sekali — secret tidak pernah dibaca/ditulis),
Steal, Kurier, HMAC, taskId mapping.

**Env var baru (semua opsional, default sudah benar):**

| Var | Default | Arti |
|---|---|---|
| `GATEKEEPER_SEEN_FILE` | `gatekeeper/seen-proof-tx.jsonl` | Path file seen-set. Di Railway, arahkan ke Volume (mis. `/data/seen-proof-tx.jsonl`). |
| `GATEKEEPER_SEEN_PERSIST` | `1` | `0` = memori saja (dipakai harness test). |
| `GATEKEEPER_PROVE_TIMEOUT_MS` | `30000` | Watchdog proof generation (ms). |
| `MAX_BODY_BYTES` | `1000000` | Batas body request (byte). |

---

## 3. Hasil test (angka nyata, semua dijalankan — bukan karangan)

### Baseline v1 (sebelum perubahan, 2026-11-18)
- `node gatekeeper/test.js` → **12/12 PASS**
- `node test-live.js` (server lokal, secret test) → **6/6 PASS**

### v2 — harness + live
- `node gatekeeper/test.js` → **12/12 PASS** (proof 297–1462 ms; kasus
  pertama 1462 ms karena load wasm, sisanya 297–486 ms). Semantik keputusan
  tidak berubah.
- `node gatekeeper/test-restart.js` → **3/3 PASS** (proses node terpisah):
  1. proses 1 record `0xrestartproof1` → `gk_restart_1`, exit;
  2. proses 2 (fresh) reload file → record masih ada, `PROOF_REUSED`
     tetap terdeteksi untuk task_id lain, retry task_id sama tetap APPROVE,
     baris malformed di-skip saat reload;
  3. file berisi tepat 1 record valid.
- `node steal/test.js` → **33/33 PASS** (tidak disentuh, regresi nol).
- `node test-live.js` (server v2 lokal, secret test) → **6/6 PASS**
  (valid task APPROVE + proof 546 ms; steal EXTRACT 878 ms).
- **Verifikasi live restart (server v2 sungguhan, file
  `/tmp/ag-v2-seen.jsonl`) — sebelum restart 4/4:**
  1. valid task `0xrestartlive1`/`gk_v2_1` → APPROVE + proof;
  2. `/health` `seenProofTx: 3, seenPersisted: true`;
  3. `amount: "12.5"` → `200 REJECT/INVALID_TASK` (bukan 500);
  4. body >1 MB → `413`.
- **Setelah restart server (file yang sama) 3/3:**
  1. `0xrestartlive1` + task_id `gk_v2_2` → `REJECT/PROOF_REUSED`;
  2. `0xrestartlive1` + task_id `gk_v2_1` → APPROVE (retry, bukan reuse);
  3. `/health` `seenProofTx` tetap 3.
- **Log keputusan terstruktur terverifikasi** (contoh baris nyata dari log):
  `{"ts":"2026-11-17T18:36:42.748Z","track":"gatekeeper","task_id":"gk_v2_1","decision":"APPROVE","reason_code":"VALID_CONDITION","proof_tx":"0xrestartlive1","proof_ms":362,"proof":"ok"}`
  — tanpa secret apa pun.
- **Satu bug implementasi ketemu & diperbaiki saat pengujian:** `readBody`
  versi pertama memakai `req.destroy()` — klien tidak menerima 413
  (fetch gagal total). Diperbaiki ke drain-then-413, diuji ulang: 413
  diterima dengan benar. Ini bukti harness live benar-benar menguji,
  bukan sekadar lewat.
- **Tidak ada file seen-set produksi yang terbuat/tercemar selama test:**
  `gatekeeper/seen-proof-tx.jsonl` tidak ada di repo setelah semua test
  (`test.js` pakai persist off; live test pakai file `/tmp`).

---

## 4. Catatan jujur / batasan

- **Deploy pertama me-reset seen-set satu kali.** Seen-set v1 hanya ada di
  memori Railway, jadi proof_tx dari Round 01–05 tidak bisa dimigrasi —
  v2 mulai dari 0 saat deploy. Setelah itu, set bertahan (restart/crash)
  dan — dengan Volume — juga saat redeploy. Deploy di jendela antar-ronde
  supaya reset terjadi di luar ronde, bukan di tengah ronde.
- **File saja tidak cukup untuk redeploy.** Filesystem container Railway
  itu ephemeral: redeploy = container baru = file hilang. Volume adalah
  satu-satunya cara set bertahan melewati redeploy. Tanpa Volume, v2 tetap
  jauh lebih baik dari v1 (tahan crash/restart dalam satu deploy), tapi
  redeploy tetap me-reset.
- **Watchdog 30 dtk bukan jaminan +12.** Kalau proof hang dan watchdog
  kena, jawaban tetap decision-only (−2 untuk task itu). Yang diperbaiki
  adalah: tidak hang, platform bisa retry, dan server tetap responsif.
- **Tidak ada yang bisa menaikkan akurasi keputusan itu sendiri** — checklist
  sudah sama dengan circuit dan sudah 12/12. Poin tambahan datang dari
  tidak-kehilangan poin (reuse terdeteksi, tidak timeout, tidak 500),
  bukan dari keputusan yang "lebih pintar".
- **Estimasi dampak:** sulit diukur pasti tanpa data ronde 01–05 (leaderboard
  terkunci di dashboard). Yang pasti: setiap trap reuse yang tadinya terlewat
  karena restart kini bernilai +12, bukan −6.

---

## 5. RENCANA DEPLOY (langkah-demi-langkah)

**Jendela aman: 03:30–17:30 WIB** (di antara ronde; Round 05 berakhir 03:30,
Round 06 mulai 17:30). Deploy SEAWAL MUNGKIN dalam jendela supaya ada waktu
verifikasi + rollback. **JANGAN deploy 17:30–03:30 WIB** (ronde berjalan —
restart mematikan proof yang sedang jalan).

### Langkah 0 — Persiapan (sebelum jendela)
- [ ] Pastikan semua test hijau (sudah — lihat §3).
- [ ] Catat `/health` Railway yang sedang live (uptime + self-test) sebagai pembanding.

### Langkah 1 — Push ke GitHub (direktori lokal ini BUKAN git repo)
```bash
# JANGAN git init di ~/workspace/agentgames (akan jadi repo bersarang + node_modules).
# Clone repo GitHub ke tempat terpisah, lalu salin file yang berubah:
git clone https://github.com/subastian1998/agent-games-season-01 /tmp/ag-deploy
cd /tmp/ag-deploy
cp ~/workspace/agentgames/server.js .
cp ~/workspace/agentgames/gatekeeper/decide.js gatekeeper/
cp ~/workspace/agentgames/gatekeeper/seenStore.js gatekeeper/
cp ~/workspace/agentgames/gatekeeper/test.js gatekeeper/
cp ~/workspace/agentgames/gatekeeper/test-restart.js gatekeeper/
cp ~/workspace/agentgames/gatekeeper/test-restart-worker.js gatekeeper/
cp ~/workspace/agentgames/.gitignore .
cp ~/workspace/agentgames/.env.example .
cp ~/workspace/agentgames/README.md .
cp ~/workspace/agentgames/package-lock.json .
cp ~/workspace/agentgames/UPGRADE-v2-REPORT.md .
git status   # HARUS hanya file di atas yang berubah; pastikan .env TIDAK ikut
git add -A && git commit -m "Gatekeeper v2: persistent seen-set, proof watchdog, fail-closed malformed tasks, body cap, structured logs"
git push origin main
```
- Auth GitHub: user yang push (akun `subastian1998`); kalau `git push`
  minta login, pakai GitHub CLI / token user — jangan minta/taruh token di chat.
- `node_modules/` JANGAN di-copy (gitignored; Railway install sendiri).

### Langkah 2 — Railway: Volume (supaya seen-set tahan redeploy)
1. Railway dashboard → service agent-games → tab **Volumes** → **Add Volume**,
   mount path `/data`.
2. Tab **Variables** → tambah `GATEKEEPER_SEEN_FILE=/data/seen-proof-tx.jsonl`.
   (Opsional, default sudah benar: `GATEKEEPER_PROVE_TIMEOUT_MS=30000`,
   `MAX_BODY_BYTES=1000000` — tidak perlu diubah.)
3. Catatan: kalau paket Railway user tidak mendukung Volume, lewati langkah
   ini — v2 tetap jalan; konsekuensinya hanya seen-set reset tiap redeploy
   (lihat §4). Jangan tunda deploy hanya karena Volume.

### Langkah 3 — Deploy
- Kalau Railway auto-deploy dari GitHub aktif: push di Langkah 1 sudah
  memicu deploy otomatis. Tunggu sampai deployment berstatus live.
- Kalau tidak aktif: Railway dashboard → Deployments → **Redeploy** (atau
  trigger manual dari commit terbaru).
- Deploy ini me-restart server sekali (di luar ronde — aman).

### Langkah 4 — Verifikasi pasca-deploy (wajib, sebelum ronde berikutnya)
1. `GET https://agent-games-season-01-production.up.railway.app/health` →
   `gatekeeper.selfTest` harus `PASS (APPROVE proof verifies locally)`,
   `steal.selfTest` PASS, `seenProofTx: 0`, `seenPersisted: true`.
   (0 karena ini deploy pertama v2 — set mulai kosong, normal.)
2. Dashboard → jalankan **satu practice task** Gatekeeper (task valid) →
   harus `APPROVE` + proof terverifikasi.
3. Cek `/health` lagi → `seenProofTx: 1` (practice task tercatat).
4. Cek log Railway → ada baris JSON
   `{"track":"gatekeeper","task_id":"...","decision":"APPROVE",...}` dan
   baris `[server] gatekeeper seen-set: 0 proof_tx from /data/seen-proof-tx.jsonl (persist on)`.
5. Kalau ada yang gagal di langkah 1–4 → rollback (Langkah 5), jangan tunggu ronde.

### Langkah 5 — Rollback (kalau ada masalah)
- **Cara cepat:** Railway dashboard → Deployments → pilih deployment
  sebelum v2 → **Redeploy**. Server kembali ke v1 (seen-set file diabaikan
  v1 — tidak ada migrasi balik yang dibutuhkan).
- **Cara git:** `git revert <commit v2> && git push` (Railway redeploy otomatis).
- Setelah rollback, ulangi verifikasi Langkah 4 terhadap v1.

### Setelah deploy berhasil
- Pantau log keputusan per ronde (baris JSON) — hitung trap yang kena
  (`PROOF_REUSED`, `THRESHOLD_MISMATCH`, dst.) vs ekspektasi.
- `/health` sebelum tiap ronde: `seenProofTx` harus naik secara monoton
  (tidak pernah turun ke 0 — kalau turun, berarti Volume/file bermasalah,
  laporkan segera).
- Jangan deploy ulang apa pun sampai turnamen selesai (21 Nov), kecuali
  darurat — setiap redeploy tanpa Volume me-reset seen-set.

---

## 6. File yang berubah (ringkas)

Baru: `gatekeeper/seenStore.js`, `gatekeeper/test-restart.js`,
`gatekeeper/test-restart-worker.js`, `package-lock.json`,
`UPGRADE-v2-REPORT.md` (file ini).
Diubah: `server.js`, `gatekeeper/decide.js`, `gatekeeper/test.js`,
`.gitignore`, `.env.example`, `README.md`.
Tidak disentuh: `gatekeeper/prove.js`, `shared/*`, `steal/*`,
`circuits/*`, `.env`, endpoint/URL.
