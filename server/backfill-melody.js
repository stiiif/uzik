// Melody column back-fill: node backfill-melody.js [data-dir]
// For every stored analysis with a v5+ blob but no melodic_score column value yet, decode the blob and
// write melodic_score/melodic_harmonicity/melodic_movement. Unlike bpm, there's no server-side estimator
// to fall back on here — melody can only ever come from decoded audio, computed client-side during a real
// analysis — so this only recovers values that are already sitting inside blobs uploaded before the
// summary columns existed. Anything on a pre-v5 blob (no melody data at all) stays blank, same as it
// always has been; it'll fill in the next time that track is (re-)analyzed. Bumps seq for changed rows so
// connected clients pick the values up through the normal delta sync. Stop the server first (or accept a
// few seconds of lock contention — SQLite WAL makes it safe either way).
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const Codec = require('./energy-codec.js');
const dataDir = process.argv[2] || process.env.DATA_DIR || '/data';
const db = new DatabaseSync(path.join(dataDir, 'tracktagger.db'));
db.exec('PRAGMA journal_mode = WAL');
for (const col of ['melodic_score', 'melodic_harmonicity', 'melodic_movement']) {
  if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === col)) db.exec(`ALTER TABLE energy ADD COLUMN ${col} INTEGER`);
}
let seq = Math.max(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM core').get().m, db.prepare('SELECT COALESCE(MAX(seq),0) m FROM energy').get().m);
const rows = db.prepare('SELECT path, blob FROM energy WHERE deleted=0 AND blob IS NOT NULL AND melodic_score IS NULL').all();
const up = db.prepare('UPDATE energy SET melodic_score=?, melodic_harmonicity=?, melodic_movement=?, seq=? WHERE path=?');
let done = 0, none = 0, bad = 0;
db.exec('BEGIN');
for (const r of rows) {
  try {
    const dec = Codec.decode(new Uint8Array(r.blob));
    if (dec.melodicScore == null) { none++; continue; } // pre-v5 blob, or v5 with melody genuinely unscored
    up.run(dec.melodicScore, dec.melodicHarmonicity, dec.melodicMovement, ++seq, r.path); done++;
  } catch (e) { bad++; }
}
db.exec('COMMIT');
console.log(`Melody back-fill: ${done} recovered from existing blobs, ${none} without melody data (pre-v5), ${bad} unreadable (of ${rows.length} candidates). maxSeq = ${seq}`);
