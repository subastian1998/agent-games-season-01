// Recursive npm-tarball installer (npm/npx are broken in this VM).
// Usage: node install.js <pkg@version> [<pkg@version> ...]
// Installs into ./node_modules next to this script. No network via npm.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'node_modules');
fs.mkdirSync(ROOT, { recursive: true });
const done = new Map(); // name -> version installed

function curl(url) {
  return execFileSync('curl', ['-sL', '--max-time', '60', url], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}
function curlBin(url, dest) {
  execFileSync('curl', ['-sL', '--max-time', '120', '-o', dest, url], { stdio: 'inherit' });
}
function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, raw: v };
}
function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}
function satisfies(ver, range) {
  const v = parseVer(ver);
  if (!v) return false;
  range = range.trim();
  if (range === '*' || range === 'latest') return !v.pre;
  // Prerelease gate (npm semver rule): a prerelease version only satisfies a
  // range that itself carries a prerelease with the same major.minor.patch.
  if (v.pre) {
    const rb = /^[\^~>=]*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(range);
    if (!rb || !rb[4]) return false;
    if (+rb[1] !== v.major || +(rb[2] ?? 0) !== v.minor || +(rb[3] ?? 0) !== v.patch) return false;
  }
  const verObj = (major, minor, patch, pre) => ({ major, minor, patch, pre: pre || null });
  let m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(range);
  if (m) return cmp(v, verObj(+m[1], +m[2], +m[3], m[4])) === 0;
  m = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(range);
  if (m) {
    const lo = verObj(+m[1], +(m[2] ?? 0), +(m[3] ?? 0), m[4]);
    let hi;
    if (lo.major > 0) hi = verObj(lo.major + 1, 0, 0);
    else if (lo.minor > 0) hi = verObj(0, lo.minor + 1, 0);
    else hi = verObj(0, 0, lo.patch + 1);
    return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
  }
  m = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(range);
  if (m) {
    const lo = verObj(+m[1], +(m[2] ?? 0), +(m[3] ?? 0), m[4]);
    const hi = verObj(lo.major, lo.minor + 1, 0);
    return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
  }
  m = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(range);
  if (m) return cmp(v, verObj(+m[1], +(m[2] ?? 0), +(m[3] ?? 0), m[4])) >= 0;
  m = /^(\d+)\.(\d+)$/.exec(range);
  if (m) {
    const lo = verObj(+m[1], +m[2], 0);
    const hi = verObj(+m[1], +m[2] + 1, 0);
    return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
  }
  m = /^[\^~]?(\d+)$/.exec(range);
  if (m) {
    const lo = verObj(+m[1], 0, 0);
    const hi = range.startsWith('~') ? verObj(+m[1], 1, 0) : verObj(+m[1] + 1, 0, 0);
    return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
  }
  m = /^(\d+)\.x(?:\.x)?$/.exec(range);
  if (m) {
    const lo = verObj(+m[1], 0, 0);
    const hi = verObj(+m[1] + 1, 0, 0);
    return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
  }
  return false;
}
function meta(name) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2F');
  return JSON.parse(curl(url));
}
function installSpec(spec) {
  const at = spec.lastIndexOf('@');
  let name, range;
  if (at > 0) { name = spec.slice(0, at); range = spec.slice(at + 1); }
  else { name = spec; range = 'latest'; }
  if (done.has(name)) return;
  console.log(`\n== ${name}@${range} ==`);
  const j = meta(name);
  let version = range;
  if (range === 'latest') version = j['dist-tags'].latest;
  else {
    const cands = Object.keys(j.versions).filter(v => satisfies(v, range)).sort((a, b) => cmp(parseVer(a), parseVer(b)));
    if (!cands.length) throw new Error(`no version of ${name} satisfies ${range}`);
    version = cands[cands.length - 1];
  }
  const verMeta = j.versions[version];
  const destDir = path.join(ROOT, name);
  if (fs.existsSync(path.join(destDir, 'package.json'))) {
    const existing = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8'));
    if (existing.version === version) {
      console.log(`already installed ${name}@${version} — checking deps`);
      done.set(name, version);
      const pkg = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8'));
      for (const [d, r] of Object.entries(Object.assign({}, pkg.dependencies || {}))) installSpec(`${d}@${r}`);
      return;
    }
  }
  console.log(`installing ${name}@${version} from ${verMeta.dist.tarball}`);
  const tmp = path.join(__dirname, `.dl-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  curlBin(verMeta.dist.tarball, tmp);
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['--no-same-owner', '-xzf', tmp, '-C', destDir, '--strip-components=1'], { stdio: 'inherit' });
  fs.unlinkSync(tmp);
  done.set(name, version);
  const pkg = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8'));
  const deps = Object.assign({}, pkg.dependencies || {});
  for (const [d, r] of Object.entries(deps)) {
    try { installSpec(`${d}@${r}`); }
    catch (e) { console.error(`!! failed dep ${d}@${r} of ${name}: ${e.message}`); throw e; }
  }
}

const specs = process.argv.slice(2);
if (!specs.length) { console.error('usage: node install.js <pkg@range> ...'); process.exit(1); }
for (const s of specs) installSpec(s);
console.log('\nDONE. Installed:', JSON.stringify(Object.fromEntries(done), null, 2));
