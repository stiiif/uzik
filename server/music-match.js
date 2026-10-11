// Finds which folder(s) of the server's music mount are the folders the devices added, and under which name.
//
// A device names a track <its folder's name>/<path inside it> ("Music/Artist/Album/01.mp3"). For the server's
// analysis to land on those same tracks it has to use the same names. Instead of being told (the old
// MUSIC_ROOT_NAME), it looks: the devices' track paths (the tracks you starred, played, noted, analysed, and
// a few examples each device sends with its folder list) are tried inside the mount and inside each of its
// subfolders, and each name goes to the folder where its tracks are found. The mount can be the folder
// itself or a folder above it ("/share/Music" mounted, "Techno" added on the laptop).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SAMPLES = 60, MIN_FOUND = 2, MIN_SHARE = 0.3;

// the devices' paths, by folder name -> Set of paths inside it
function evidence(db, telegramNames = []) {
  const by = new Map();
  const add = p => {
    if (typeof p !== 'string') return;
    const i = p.indexOf('/');
    if (i <= 0 || i === p.length - 1) return;
    const root = p.slice(0, i), rel = p.slice(i + 1);
    if (telegramNames.includes(root) || /^https?:$/.test(root)) return;
    let s = by.get(root); if (!s) by.set(root, s = new Set());
    if (s.size < 4000) s.add(rel);
  };
  try {
    for (const r of db.prepare("SELECT kind, key, payload FROM core WHERE removed=0 AND kind IN ('tags','played','meta','vibes','notes','settings') ORDER BY seq DESC LIMIT 200000").iterate()) {
      if (r.kind === 'settings') {
        if (!r.key.startsWith('connectedFolders:')) continue;
        let v; try { v = JSON.parse(r.payload).value; } catch (e) { continue; }
        for (const f of (v && v.folders) || []) {
          if (!f || !f.name) continue;
          if (!by.has(f.name)) by.set(f.name, new Set());
          for (const rel of f.samples || []) add(f.name + '/' + rel);
        }
        continue;
      }
      if (r.kind === 'vibes') add(r.key.slice(0, r.key.lastIndexOf('|')));
      else if (r.kind === 'notes') add(r.key.slice(r.key.indexOf('|') + 1));
      else add(r.key);
    }
    for (const r of db.prepare('SELECT path FROM energy WHERE deleted=0 ORDER BY seq DESC LIMIT 200000').iterate()) add(r.path);
  } catch (e) { /* tables not there yet */ }
  return by;
}

// spread-out sample of a set
function sample(set, n) {
  const a = [...set];
  if (a.length <= n) return a;
  const out = [], step = a.length / n;
  for (let i = 0; i < n; i++) out.push(a[Math.floor(i * step)]);
  return out;
}

// the mount and its subfolders (two levels), each with the names it holds
async function candidateDirs(base) {
  const out = [];
  const read = async d => { try { return await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return null; } };
  const top = await read(base);
  if (!top) return out;
  out.push({ dir: base, names: new Set(top.map(e => e.name)) });
  for (const e of top) {
    if (!e.isDirectory() || e.name.startsWith('.') || out.length > 400) continue;
    const d1 = path.join(base, e.name), l1 = await read(d1);
    if (!l1) continue;
    out.push({ dir: d1, names: new Set(l1.map(x => x.name)) });
    for (const f of l1) {
      if (!f.isDirectory() || f.name.startsWith('.') || out.length > 400) continue;
      const d2 = path.join(d1, f.name), l2 = await read(d2);
      if (l2) out.push({ dir: d2, names: new Set(l2.map(x => x.name)) });
    }
  }
  return out;
}

const exists = async p => { try { await fsp.access(p); return true; } catch (e) { return false; } };

// -> { dir, at, roots: [{ name, dir, found, tried }], unmatched: [{ name, tried }], error? }
async function matchMusic(db, base, { telegramNames = [] } = {}) {
  const at = Date.now();
  if (!base || !fs.existsSync(base)) return { dir: base, at, roots: [], unmatched: [], error: base ? `${base} isn't there (no music folder mounted)` : 'no music folder' };
  const ev = evidence(db, telegramNames);
  const dirs = await candidateDirs(base);
  const tries = [];
  for (const [name, set] of ev) {
    const s = sample(set, SAMPLES);
    if (!s.length) {
      // only a folder name (a device with no tracks used yet): a subfolder of that name, if there's one
      const d = dirs.find(x => path.basename(x.dir) === name && x.dir !== base);
      if (d) tries.push({ name, dir: d.dir, found: 0, tried: 0, byName: true });
      else tries.push({ name, dir: null, found: 0, tried: 0 });
      continue;
    }
    // quick pre-score: the first part of each path among the names a folder holds
    const firsts = s.map(rel => rel.split('/')[0]);
    const ranked = dirs.map(d => ({ d, n: firsts.reduce((k, f) => k + (d.names.has(f) ? 1 : 0), 0) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
    let best = { name, dir: null, found: 0, tried: s.length };
    for (const { d } of ranked) {
      let found = 0;
      for (const rel of s) if (await exists(path.join(d.dir, rel))) found++;
      if (found > best.found) best = { name, dir: d.dir, found, tried: s.length };
    }
    tries.push(best);
  }
  // keep the best matches, one name per folder, no folder inside another
  const good = tries.filter(t => t.dir && (t.byName || (t.found >= Math.min(MIN_FOUND, t.tried) && t.found / t.tried >= MIN_SHARE)))
    .sort((a, b) => (b.found - a.found) || (a.byName ? 1 : 0) - (b.byName ? 1 : 0));
  const roots = [];
  const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  for (const t of good) if (!roots.some(r => overlaps(r.dir, t.dir))) roots.push({ name: t.name, dir: t.dir, found: t.found, tried: t.tried });
  const unmatched = tries.filter(t => !roots.some(r => r.name === t.name)).map(t => ({ name: t.name, tried: t.tried, found: t.found, dir: t.dir }));
  return { dir: base, at, roots, unmatched, folders: dirs.slice(0, 200).map(d => d.dir) };
}

module.exports = { matchMusic, evidence };
