// Tier-1 BPM back-fill: node backfill-bpm.js [data-dir]
// For every stored analysis without a bpm, estimate it from the kick timestamps already inside the blob,
// write the bpm/bpm_source columns, and re-encode the blob as v3 so clients also get it when they fetch
// the waveform. This is Tier-1 only (kick-interval based) — the server has no decoded audio to run the
// heavier Tier-2 envelope pass, so anything Tier-1 can't read stays blank here; those get Tier-2 client-side
// the next time they're (re-)analyzed. Bumps seq for changed rows so connected clients pick the new values
// up through the normal delta sync. Stop the server first (or accept a few seconds of lock contention —
// SQLite WAL makes it safe either way).
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const Codec = require('./energy-codec.js');
const dataDir = process.argv[2] || process.env.DATA_DIR || '/data';
const db = new DatabaseSync(path.join(dataDir, 'tracktagger.db'));
db.exec('PRAGMA journal_mode = WAL');
if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === 'bpm')) db.exec('ALTER TABLE energy ADD COLUMN bpm REAL');
if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === 'bpm_source')) db.exec('ALTER TABLE energy ADD COLUMN bpm_source TEXT');
let seq = Math.max(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM core').get().m, db.prepare('SELECT COALESCE(MAX(seq),0) m FROM energy').get().m);
const rows = db.prepare('SELECT path, blob FROM energy WHERE deleted=0 AND blob IS NOT NULL AND bpm IS NULL').all();
const up = db.prepare('UPDATE energy SET bpm=?, bpm_source=?, blob=?, seq=? WHERE path=?');
let done = 0, none = 0, bad = 0;
db.exec('BEGIN');
for (const r of rows) {
  try {
    const dec = Codec.decode(new Uint8Array(r.blob));
    const est = dec.bpm != null ? { bpm: dec.bpm, bpmConf: dec.bpmConf, bpmSource: dec.bpmSource || 'kick' } : (() => {
      const e = Codec.estimateBpmFromKicks(dec.kickTimes); return e ? { ...e, bpmSource: 'kick' } : null;
    })();
    if (!est) { none++; continue; }
    up.run(est.bpm, est.bpmSource, Buffer.from(Codec.encode({ ...dec, ...est })), ++seq, r.path); done++;
  } catch (e) { bad++; }
}
db.exec('COMMIT');
console.log(`BPM back-fill: ${done} estimated, ${none} without enough kicks, ${bad} unreadable (of ${rows.length} candidates). maxSeq = ${seq}`);
