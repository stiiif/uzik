// One-time migration: node import.js /path/to/state.json [/path/to/data-dir]
// Reads the old single-blob state.json and inserts every record into tracktagger.db.
// Safe to re-run: existing rows are only replaced when the imported record is newer (same LWW rule).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const Codec = require('./energy-codec.js');

const src = process.argv[2];
const dataDir = process.argv[3] || process.env.DATA_DIR || '/data';
if (!src) { console.error('usage: node import.js state.json [data-dir]'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'tracktagger.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS core (kind TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (kind, key));
  CREATE INDEX IF NOT EXISTS core_seq ON core(seq);
  CREATE TABLE IF NOT EXISTS energy (path TEXT PRIMARY KEY, ts INTEGER NOT NULL DEFAULT 0, intensity INTEGER, blob BLOB, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS energy_seq ON energy(seq);
`);
let seq = Math.max(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM core').get().m, db.prepare('SELECT COALESCE(MAX(seq),0) m FROM energy').get().m);
const coreGet = db.prepare('SELECT ts FROM core WHERE kind=? AND key=?');
const coreUp = db.prepare('INSERT INTO core (kind,key,ts,removed,payload,seq) VALUES (?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET ts=excluded.ts, removed=excluded.removed, payload=excluded.payload, seq=excluded.seq');
const enGet = db.prepare('SELECT ts FROM energy WHERE path=?');
const enUp = db.prepare('INSERT INTO energy (path,ts,intensity,blob,deleted,seq) VALUES (?,?,?,?,0,?) ON CONFLICT(path) DO UPDATE SET ts=excluded.ts, intensity=excluded.intensity, blob=excluded.blob, deleted=0, seq=excluded.seq');

const KEY = {
  tags: e => e.path, played: e => e.path, excluded: e => e.prefix,
  vibes: e => e.path + '|' + e.tag, notes: e => `${e.ts}|${e.path}`
};
const REMOVED = {
  tags: e => !!e.removed, notes: e => !!e.removed, played: e => e.played === false,
  excluded: e => e.excluded === false, vibes: e => e.on === false
};
const stats = {};
db.exec('BEGIN');
for (const kind of Object.keys(KEY)) {
  let n = 0;
  for (const e of raw[kind] || []) {
    const key = KEY[kind](e); if (key == null) continue;
    const ts = Number(e.ts) || 0;
    const cur = coreGet.get(kind, key);
    if (cur && cur.ts >= ts) continue;
    coreUp.run(kind, key, ts, REMOVED[kind](e) ? 1 : 0, JSON.stringify(e), ++seq); n++;
  }
  stats[kind] = n;
}
let nMeta = 0;
for (const [p, v] of Object.entries(raw.meta || {})) {
  const ts = Number(v && v._ts) || 0;
  const cur = coreGet.get('meta', p);
  if (cur && cur.ts >= ts) continue;
  coreUp.run('meta', p, ts, 0, JSON.stringify(v), ++seq); nMeta++;
}
stats.meta = nMeta;
let nEnergy = 0, bad = 0;
for (const [p, v] of Object.entries(raw.energy || {})) {
  try {
    const entry = Codec.fromLegacy(v);
    const ts = Number(v.ts) || 0;
    const cur = enGet.get(p);
    if (cur && cur.ts >= ts) continue;
    enUp.run(p, ts, v.intensity == null ? null : Number(v.intensity), Codec.encode(entry), ++seq); nEnergy++;
  } catch (e) { bad++; }
}
stats.energy = nEnergy;
db.exec('COMMIT');
console.log('Imported:', stats, bad ? `(skipped ${bad} unreadable energy entries)` : '', 'maxSeq =', seq);
