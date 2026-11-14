// Track Tagger sync server v2 — row-level SQLite store with sequence-based delta sync.
// Zero npm dependencies (uses node:sqlite, Node >= 22.13).
//
// Data model
//   core   (kind, key)  -> ts, removed, payload   small mutable records: tags/notes/played/excluded/vibes/meta
//   energy (path)       -> ts, intensity, blob    large write-once analysis blobs (~1.8 KB each)
//   Every write bumps a global `seq`; clients pull `GET /changes?since=<seq>` and only ever see rows
//   that changed after their last cursor. Conflict rule is last-write-wins by the record's own `ts`
//   (same rule the extension used before, now applied server-side too).
//
// Who may use it (auth.js): devices paired with a 6-digit code, each with its own key
// (`Authorization: Bearer <device key>`, or ?token= for live updates and audio streams); the old shared
// SYNC_TOKEN too while it's set and not switched off. Only from the home network by default (netguard.js).
//
// Endpoints (all but /, /health and /pair* need a key)
//   GET  /                                     the status page (pairing code for the first device)
//   GET  /health                               {app, id, name, version}; everything else with a key
//   POST /pair            {code,name,platform} -> {deviceId, key, server}
//   POST /pair/page-code                       a code: on the page while no device is paired, else in the log
//   POST /pair/code                            a code for another device (from a paired one)
//   POST /pair/upgrade    {name,platform}      old shared token -> a device key
//   GET  /devices · POST /devices/remove {id} · POST /devices/rename {id,name}
//   POST /server/legacy-token {on}             the old shared token: switch it off (or on)
//   GET  /server/settings · POST /server/settings {…}   the server's settings (settings.js)
//   POST /server/music/match                   look for the music folders again (music-match.js)
//   *    /tg/…                                 the Telegram bridge, through this server (tg-proxy.js)
//   GET  /health (with a key)                  {ok, maxSeq, …}
//   GET  /changes?since=N&kinds=core|energy&limit=M
//                                               core: full rows; energy: summaries (path, ts, intensity, deleted)
//   POST /changes         {core:[rows]}         LWW merge, returns {maxSeq, applied, rejected}
//   GET  /energy?path=P                         one blob (base64)
//   POST /energy/fetch    {paths:[...]}         batch blobs
//   POST /energy          {rows:[{path,ts,intensity,blob}]}  upload (Content-Encoding: gzip accepted)
//   POST /energy/delete   {paths:[...]}         tombstones
//   GET  /events?token=T                        SSE: "data: {maxSeq}" on every write + heartbeat
//   GET  /presence / POST /presence             in-memory heartbeat, advisory only
//   GET  /controller-presets · POST {preset} · POST /get {id} · POST /delete {id}   Controllers' saved presets
//   GET  /backups                               the backups (Uzikext archives, see backups.js / archive.js)
//   POST /backups/now     {scope:'data'|'full'} make one now
//   GET  /backups/file?name=N                   download one
//   POST /backups/restore?name=N                restore one of them (merge: see archive.js)
//   POST /backups/restore (body: a .uzx file)   restore from an uploaded archive

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const Codec = require('./energy-codec.js');
const { startAnalysisScheduler } = require('./analysis-scheduler.js');
const { createBackups } = require('./backups.js');
const { openArchive, describeArchive, restoreArchive } = require('./archive.js');
const crypto = require('crypto');
const os = require('os');
const { createAuth } = require('./auth.js');
const { createGuard } = require('./netguard.js');
const { startDiscovery, localV4 } = require('./discovery.js');
const { createSettings, mounts } = require('./settings.js');
const { matchMusic } = require('./music-match.js');
const { createTgProxy } = require('./tg-proxy.js');
const { startBridge, bundledBridge } = require('./telegram-runner.js');
const { startUpdateCheck } = require('./update-check.js');
const { statusPage } = require('./status-page.js');
const SERVER_VERSION = 4;            // the protocol, what Uzikext checks
const SERVER_RELEASE = '4.3.1';      // this release (the update check compares it)

const PORT = Number(process.env.PORT) || 8787;
// Inside the Uzikext app (SERVER_MODE=app): the app starts this server, listening on this computer only
// (BIND=127.0.0.1, "just this computer") or for the other devices too ("this computer is the server"), and
// manages it through /local/… with LOCAL_ADMIN_KEY (from this computer only). It stops with the app.
const SERVER_MODE = process.env.SERVER_MODE || 'server';
const BIND = process.env.BIND || undefined;
const LOCAL_ADMIN_KEY = process.env.LOCAL_ADMIN_KEY || '';
if (process.env.PARENT_WATCH === 'stdin') { process.stdin.on('end', () => process.exit(0)); process.stdin.on('error', () => process.exit(0)); process.stdin.resume(); }
const TOKEN = process.env.SYNC_TOKEN || '';   // the old shared token: optional now (devices pair with a code)
const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = path.join(DATA_DIR, 'tracktagger.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BODY = Number(process.env.MAX_BODY) || 32 * 1024 * 1024;
// Backups (backups.js): an hourly archive of your data, a daily full one, kept by a rotation, copied to
// BACKUP_COPY_DIR (a second folder, ideally on another disk or machine) when it's set.
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? n : d; };
const BACKUP_HOURLY_MS = num(process.env.BACKUP_HOURLY_MS, 60 * 60 * 1000);
const BACKUP_DAILY_MS = num(process.env.BACKUP_DAILY_MS, 24 * 60 * 60 * 1000);
const BACKUP_KEEP = {
  hourly: num(process.env.BACKUP_KEEP_HOURLY, 48), daily: num(process.env.BACKUP_KEEP_DAILY, 14),
  weekly: num(process.env.BACKUP_KEEP_WEEKLY, 8), monthly: num(process.env.BACKUP_KEEP_MONTHLY, 12),
  manual: num(process.env.BACKUP_KEEP_MANUAL, 10), beforeRestore: num(process.env.BACKUP_KEEP_BEFORE_RESTORE, 10)
};
const BACKUP_COPY_DIR = process.env.BACKUP_COPY_DIR || '';
const BACKUP_UPLOAD_MAX = num(process.env.BACKUP_UPLOAD_MAX, 2 * 1024 * 1024 * 1024);   // an uploaded archive, to restore
const TOMBSTONE_TTL_MS = Number(process.env.TOMBSTONE_TTL_MS) || 90 * 24 * 60 * 60 * 1000;
// Background analysis — disabled unless MUSIC_DIR is set (a mount pointing at the same music library the
// extension's Folder tracks use). MUSIC_ROOT_NAME must match the literal name the browser's folder picker
// gave that folder (see library-scan.js's header comment for why) — there's no way to infer this, it has
// to be told.
// The music folder: MUSIC_DIR, or /music when something is mounted there. The names the devices know its
// folders by are found by themselves (music-match.js); MUSIC_ROOT_NAME still forces one, as before.
const MUSIC_DIR = process.env.MUSIC_DIR || (fs.existsSync('/music') ? '/music' : '');
const MUSIC_ROOT_NAME = process.env.MUSIC_ROOT_NAME || '';
const ANALYSIS_PACE_MS = Number(process.env.ANALYSIS_PACE_MS) || 2000; // gap between tracks — a dedicated
  // 24/7 box has no "don't slow down my typing" concern the way a work laptop does, but this still avoids
  // pegging the NAS's CPU/disk with zero breathing room for its other duties (file serving, other containers)
const ANALYSIS_RESCAN_MS = Number(process.env.ANALYSIS_RESCAN_MS) || 30 * 60 * 1000; // how often to re-walk
  // the library for newly-added tracks; a library scan is cheap (just a directory walk), no need to do it often
const ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY) || 1); // how many tracks
  // analyze simultaneously, each on its own worker thread. Defaults to 1 (no behavior change unless set) —
  // this is now safe to raise specifically because each lane's DSP work is isolated on its own worker
  // thread and can't block the HTTP server; the only real tradeoff left is sustained NAS CPU/disk load,
  // which is why it's an explicit opt-in rather than a higher default.
const ANALYSIS_MAX_DURATION_SEC = Number(process.env.ANALYSIS_MAX_DURATION_SEC) || 20 * 60; // tracks longer
  // than this are excluded from the automatic background scheduler entirely — extended DJ mixes and live
  // sets are exactly the tracks where the per-track cost (M04/TSER especially — see medianOf's header
  // comment in energy-analysis-core.js) is worst, and the person may prefer to trigger analysis on those
  // manually (from uzikext's own Analyze button, a completely separate path that doesn't check this limit
  // at all) rather than let the automatic backlog spend disproportionate time on them. 0 disables the
  // limit entirely (nothing is ever too long).
const CHANGES_LIMIT_MAX = 5000;
// (grids: each track's beat grid as the grid analysis found it, worked out here or on a computer: grid-dsp.js)
const CORE_KINDS = new Set(['tags', 'notes', 'played', 'excluded', 'vibes', 'meta', 'settings', 'bans', 'grids']);

const guard = createGuard({ allowFrom: process.env.ALLOW_FROM || 'home', corsOrigins: process.env.CORS_ORIGINS || '' });

// ---------- database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS core (
    kind TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (kind, key)
  );
  CREATE INDEX IF NOT EXISTS core_seq ON core(seq);
  CREATE TABLE IF NOT EXISTS energy (
    path TEXT PRIMARY KEY, ts INTEGER NOT NULL DEFAULT 0, intensity INTEGER, blob BLOB,
    deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS energy_seq ON energy(seq);
`);

// v2.1: bpm column (Tier-1 tempo from kick timestamps). Added in place if missing.
if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === 'bpm')) db.exec('ALTER TABLE energy ADD COLUMN bpm REAL');
// v2.2: bpm_source ('kick'|'envelope'|'hybrid') — which estimator produced the bpm column, so a client
// can tell a Tier-1-only track from one that's already had the (much more expensive) Tier-2 envelope pass.
if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === 'bpm_source')) db.exec('ALTER TABLE energy ADD COLUMN bpm_source TEXT');
// v2.4: melodic_score/melodic_harmonicity/melodic_movement (0-100, NULL = unknown) — same treatment as bpm:
// previously these only lived inside the blob (fetched on demand, per track), so a device that hadn't yet
// pulled a given track's blob showed no melody score even though the server had it. Now summarized as
// columns like bpm/bpm_source, so they ride the lightweight /changes delta instead of requiring a full
// blob fetch. Melody can only ever come from decoded audio (client-side), so there's no server-side
// estimator to run here the way Tier-1 bpm has one — see backfill-melody.js for existing blobs.
for (const col of ['melodic_score', 'melodic_harmonicity', 'melodic_movement']) {
  if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === col)) db.exec(`ALTER TABLE energy ADD COLUMN ${col} INTEGER`);
}
// v2.5: sub_hz/sub_quality — same treatment as bpm/melody: promoted out of the blob into columns so they
// ride the lightweight /changes delta instead of requiring a full blob fetch. No server-side estimator
// (needs decoded stereo audio, client-side only) — this is purely "read it off the blob if the client
// didn't send it separately", same as melody.
for (const col of ['sub_hz', 'sub_quality']) {
  if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === col)) db.exec(`ALTER TABLE energy ADD COLUMN ${col} INTEGER`);
}
// v2.6: explosiveness (the OLD single-column, single-score version) — dead as of v2.7 below; left in
// place, unused, purely so an old blob/row from before this rework still reads without special-casing.
if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === 'explosiveness')) db.exec('ALTER TABLE energy ADD COLUMN explosiveness INTEGER');
// v2.7: explosiveness_metrics — the ACTUAL current version. Explosiveness turned out to need a genuinely
// different design from bpm/melody/sub-bass: there is no single 0-100 score computed at analysis time at
// all anymore (the old fixed-bound version was badly miscalibrated — see computeExplosivenessMetrics's
// header comment in energy-analysis-core.js). Instead, the 9 RAW sub-metrics are stored here as one
// JSON-encoded object ({m01..m09}), and uzikext computes the actual 0-100 score itself, ranked against
// whichever tracks are currently visible — never a fixed scale, never computed or stored here. One TEXT
// column rather than 9 separate numeric ones deliberately: nothing server-side ever needs to query, sort,
// or filter by an individual raw metric — this table only needs to store and forward the bundle, uzikext
// is the only thing that actually reads inside it. Like sub_hz/sub_quality, this CAN be computed server-
// side (analysis-scheduler.js does, via analysis-dsp.js) since it doesn't need stereo audio.
if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === 'explosiveness_metrics')) db.exec('ALTER TABLE energy ADD COLUMN explosiveness_metrics TEXT');
// v2.8: duration_sec + skip_reason — lets the background scheduler (analysis-scheduler.js) permanently
// exclude a track from automatic analysis (currently just "too long", via ANALYSIS_MAX_DURATION_SEC)
// without re-deciding on every single rescan. Without skip_reason, a track this long would look
// identical to "genuinely still needs analysis" forever (it has no explosiveness_metrics, since it was
// never analyzed) — every rescan would re-discover it, re-decode it just to check its length again, and
// never actually finish. skip_reason marks it as a deliberate, permanent decision instead; duration_sec is
// stored alongside it (and for normally-analyzed tracks too, once known) so a future duration-based
// decision never needs a fresh probe.
for (const col of ['duration_sec', 'skip_reason']) {
  if (!db.prepare("PRAGMA table_info(energy)").all().some(c => c.name === col)) db.exec(`ALTER TABLE energy ADD COLUMN ${col} ${col === 'duration_sec' ? 'REAL' : 'TEXT'}`);
}
let maxSeq = Math.max(
  db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM core').get().m,
  db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM energy').get().m
);
const nextSeq = () => ++maxSeq;

// The database's identity (epoch): made once, with the database. A device keeps it with its sync position;
// when it changes (a new or replaced database), or the server's position is behind the device's (an older
// copy put back), the device syncs from the start again instead of missing what's there.
db.exec('CREATE TABLE IF NOT EXISTS info (key TEXT PRIMARY KEY, value TEXT)');
const infoGet = db.prepare('SELECT value FROM info WHERE key=?'), infoSet = db.prepare('INSERT INTO info (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const getInfo = k => { const r = infoGet.get(k); return r ? r.value : null; };
const setInfo = (k, v) => infoSet.run(k, String(v));
let EPOCH = getInfo('epoch');
if (!EPOCH) { EPOCH = crypto.randomBytes(8).toString('hex'); setInfo('epoch', EPOCH); }
// The furthest this database got is also kept OUTSIDE it (data/epoch.json): an older copy of the database
// file put back in its place (it carries the same epoch, but is behind) gets a new epoch, so the devices
// don't skip what they think they already have.
// (Also in the backups' copy folder, when there is one: restoring the whole data folder from a snapshot
// brings its own old epoch.json back, but not the copy folder's.)
// (the copy folder's can change from Uzikext's settings: see epochFiles())
const EPOCH_FILES = [path.join(DATA_DIR, 'epoch.json')];
const storedCopyDir = (() => { try { const b = (JSON.parse(getInfo('server_settings') || '{}').backups) || {}; return b.copyDir != null ? b.copyDir : BACKUP_COPY_DIR; } catch (e) { return BACKUP_COPY_DIR; } })();
const copyEpochFile = dir => dir ? path.join(dir, 'uzikext-sync-position.json') : null;
EPOCH_FILES.push(copyEpochFile(storedCopyDir));
const dbMaxSeq = () => Math.max(db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM core').get().m, db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM energy').get().m);
for (const f of EPOCH_FILES) {
  if (!f) continue;
  try {
    const was = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (was && was.epoch === EPOCH && Number(was.maxSeq) > maxSeq) {
      EPOCH = crypto.randomBytes(8).toString('hex'); setInfo('epoch', EPOCH);
      console.warn(`The database is behind where it was (${maxSeq} < ${was.maxSeq}, ${f}: an older copy put back?): new epoch ${EPOCH}, the devices sync from the start`);
      break;
    }
  } catch (e) { /* first start, or no copy folder */ }
}
const epochSaved = EPOCH_FILES.map(() => ({ seq: -1, at: 0 }));
function saveEpochFiles(force) {
  const seq = dbMaxSeq();   // (what's really in the database: not a write that was rolled back)
  EPOCH_FILES.forEach((f, i) => {
    const st = epochSaved[i];
    if (!f || st.seq === seq) return;
    if (i > 0 && !force && Date.now() - st.at < 60000) return;   // the copy folder: at most once a minute
    try {
      if (i > 0 && !fs.existsSync(path.dirname(f))) return;   // (not mounted: never created)
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ epoch: EPOCH, maxSeq: seq })); fs.renameSync(tmp, f);
      st.seq = seq; st.at = Date.now();
    } catch (e) {}
  });
}
saveEpochFiles(true);
setInterval(saveEpochFiles, 5000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveEpochFiles(true); process.exit(0); });

const stmts = {
  coreGet: db.prepare('SELECT ts, removed FROM core WHERE kind=? AND key=?'),
  coreGetFull: db.prepare('SELECT ts, removed, payload FROM core WHERE kind=? AND key=?'),
  coreUpsert: db.prepare('INSERT INTO core (kind,key,ts,removed,payload,seq) VALUES (?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET ts=excluded.ts, removed=excluded.removed, payload=excluded.payload, seq=excluded.seq'),
  coreChanges: db.prepare('SELECT kind, key, ts, removed, payload, seq FROM core WHERE seq > ? ORDER BY seq LIMIT ?'),
  coreAll: db.prepare('SELECT kind, key, ts, removed, payload FROM core ORDER BY kind, key'),
  corePrune: db.prepare('DELETE FROM core WHERE removed=1 AND ts < ?'),
  energyGetMeta: db.prepare('SELECT ts, deleted FROM energy WHERE path=?'),
  energyGet: db.prepare('SELECT path, ts, intensity, bpm, bpm_source, melodic_score, melodic_harmonicity, melodic_movement, sub_hz, sub_quality, explosiveness_metrics, blob, deleted FROM energy WHERE path=?'),
  energyUpsert: db.prepare('INSERT INTO energy (path,ts,intensity,bpm,bpm_source,melodic_score,melodic_harmonicity,melodic_movement,sub_hz,sub_quality,explosiveness_metrics,blob,deleted,seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET ts=excluded.ts, intensity=excluded.intensity, bpm=excluded.bpm, bpm_source=excluded.bpm_source, melodic_score=excluded.melodic_score, melodic_harmonicity=excluded.melodic_harmonicity, melodic_movement=excluded.melodic_movement, sub_hz=excluded.sub_hz, sub_quality=excluded.sub_quality, explosiveness_metrics=excluded.explosiveness_metrics, blob=excluded.blob, deleted=excluded.deleted, seq=excluded.seq'),
  energyChanges: db.prepare('SELECT path, ts, intensity, bpm, bpm_source, melodic_score, melodic_harmonicity, melodic_movement, sub_hz, sub_quality, explosiveness_metrics, deleted, seq FROM energy WHERE seq > ? ORDER BY seq LIMIT ?'),
  // Dedicated statement for recording a background-scheduler skip decision (currently just "too long" —
  // see ANALYSIS_MAX_DURATION_SEC), separate from energyUpsert on purpose: duration_sec/skip_reason are
  // pure server-internal bookkeeping, deliberately never exposed via energyGet/energyChanges to the
  // client — uzikext's own Analyze button is a completely separate path that doesn't check this at all,
  // so a person can still manually analyze a skipped track without this decision ever reaching them. The
  // ON CONFLICT branch only touches these two columns plus ts/seq, leaving any other existing data on that
  // row (there normally isn't any for a path reaching this — it's only ever called for paths the scheduler
  // hasn't analyzed yet) completely alone rather than risking clobbering it.
  energyMarkSkipped: db.prepare('INSERT INTO energy (path,ts,duration_sec,skip_reason,deleted,seq) VALUES (?,?,?,?,0,?) ON CONFLICT(path) DO UPDATE SET ts=excluded.ts, duration_sec=excluded.duration_sec, skip_reason=excluded.skip_reason, seq=excluded.seq'),
  energyPrune: db.prepare('DELETE FROM energy WHERE deleted=1 AND ts < ?'),
  counts: db.prepare('SELECT (SELECT COUNT(*) FROM core) AS core, (SELECT COUNT(*) FROM energy WHERE deleted=0) AS energy')
};

// ---------- write helpers (LWW by ts) ----------
function applyCoreRows(rows) {
  let applied = 0; const rejected = [];
  const seqStart = maxSeq;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!r || !CORE_KINDS.has(r.kind) || typeof r.key !== 'string') continue;
      const ts = Number(r.ts) || 0, removed = r.removed ? 1 : 0;
      const cur = stmts.coreGet.get(r.kind, r.key);
      // Notes are immutable-by-ts: a removal must stick even if both sides carry the same ts.
      const accept = !cur || ts > cur.ts || (ts === cur.ts && removed && !cur.removed);
      if (!accept) { rejected.push({ kind: r.kind, key: r.key, ts: cur.ts }); continue; }
      stmts.coreUpsert.run(r.kind, r.key, ts, removed, JSON.stringify(r.payload ?? null), nextSeq());
      applied++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); maxSeq = seqStart; throw e; }
  return { applied, rejected };
}

function applyEnergyRows(rows) {
  let applied = 0; const rejected = [];
  const seqStart = maxSeq;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!r || typeof r.path !== 'string') continue;
      const ts = Number(r.ts) || 0;
      const cur = stmts.energyGetMeta.get(r.path);
      if (cur && ts < cur.ts) { rejected.push({ path: r.path, ts: cur.ts }); continue; }
      if (cur && ts === cur.ts && !cur.deleted) { continue; } // identical — nothing to do, don't bump seq
      let blob = null, bpm = r.bpm == null ? null : Number(r.bpm), bpmSource = r.bpmSource || null;
      let melodicScore = r.melodicScore == null ? null : Number(r.melodicScore);
      let melodicHarmonicity = r.melodicHarmonicity == null ? null : Number(r.melodicHarmonicity);
      let melodicMovement = r.melodicMovement == null ? null : Number(r.melodicMovement);
      let subHz = r.subHz == null ? null : Number(r.subHz);
      let subQuality = r.subQuality == null ? null : Number(r.subQuality);
      let explosivenessMetrics = r.explosivenessMetrics ? JSON.stringify(r.explosivenessMetrics) : null;
      if (r.blob) {
        blob = Buffer.from(r.blob, 'base64');
        let dec;
        try { dec = Codec.decode(blob); } catch (e) { rejected.push({ path: r.path, error: 'bad blob' }); continue; }
        if (bpm == null) { // client didn't say — derive from the blob (v3 tail, else Tier-1 estimate from kicks)
          if (dec.bpm != null) { bpm = dec.bpm; bpmSource = dec.bpmSource || bpmSource; }
          else { const est = Codec.estimateBpmFromKicks(dec.kickTimes); if (est) { bpm = est.bpm; bpmSource = 'kick'; blob = Buffer.from(Codec.encode({ ...dec, ...est, bpmSource: 'kick' })); } }
        } else if (!bpmSource) bpmSource = dec.bpmSource || null;
        // Melody has no server-side estimator (unlike bpm's Tier-1 kick fallback) — it can only ever come
        // from decoded audio, so this is purely "client didn't send it separately — read it off the blob".
        if (melodicScore == null) melodicScore = dec.melodicScore;
        if (melodicHarmonicity == null) melodicHarmonicity = dec.melodicHarmonicity;
        if (melodicMovement == null) melodicMovement = dec.melodicMovement;
        // Sub-bass, same treatment: no server-side estimator, purely "read it off the blob if the client
        // didn't already summarize it".
        if (subHz == null) subHz = dec.subHz;
        if (subQuality == null) subQuality = dec.subQuality;
        // Same "read it off the blob if the client didn't send it separately" fallback — though unlike
        // sub-bass, this CAN also be computed server-side (see analysis-scheduler.js), so this path
        // matters mainly for older client pushes from before the summary field existed.
        if (explosivenessMetrics == null && dec.explosivenessMetrics) explosivenessMetrics = JSON.stringify(dec.explosivenessMetrics);
      }
      stmts.energyUpsert.run(r.path, ts, r.intensity == null ? null : Number(r.intensity), bpm, bpmSource,
        melodicScore, melodicHarmonicity, melodicMovement, subHz, subQuality, explosivenessMetrics, blob, 0, nextSeq());
      applied++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); maxSeq = seqStart; throw e; }
  return { applied, rejected };
}

function deleteEnergyPaths(paths, ts) {
  let n = 0;
  const seqStart = maxSeq;
  db.exec('BEGIN');
  try {
    for (const p of paths) {
      if (typeof p !== 'string') continue;
      const cur = stmts.energyGetMeta.get(p);
      if (!cur || cur.deleted) continue;
      stmts.energyUpsert.run(p, ts, null, null, null, null, null, null, null, null, null, null, 1, nextSeq());
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); maxSeq = seqStart; throw e; }
  return n;
}

// ---------- the server's identity, settings, devices ----------
let SERVER_ID = getInfo('server_id');
if (!SERVER_ID) { SERVER_ID = crypto.randomBytes(8).toString('hex'); setInfo('server_id', SERVER_ID); }
const settings = createSettings({ getInfo, setInfo, defaults: {
  name: process.env.SERVER_NAME || 'Uzikext server',
  analysis: { concurrency: ANALYSIS_CONCURRENCY, paceMs: ANALYSIS_PACE_MS, maxDurationSec: ANALYSIS_MAX_DURATION_SEC, rescanMs: ANALYSIS_RESCAN_MS },
  backups: { hourly: true, daily: true, keep: BACKUP_KEEP, copyDir: BACKUP_COPY_DIR, hourlyMs: BACKUP_HOURLY_MS, dailyMs: BACKUP_DAILY_MS },
  music: { dir: MUSIC_DIR, roots: MUSIC_ROOT_NAME && MUSIC_DIR ? [{ name: MUSIC_ROOT_NAME, dir: MUSIC_DIR }] : null },
  telegram: { apiId: process.env.TG_API_ID || '', apiHash: process.env.TG_API_HASH || '',
    // (docker-compose's starting values for the bridge's sync; ⋮ → Library → Telegram → Sync changes them)
    refreshMinutes: Number(process.env.REFRESH_MINUTES) || 60,
    scanYears: process.env.SCAN_YEARS != null && process.env.SCAN_YEARS !== '' && Number.isFinite(Number(process.env.SCAN_YEARS)) ? Number(process.env.SCAN_YEARS) : 3,
    tagConcurrency: Number(process.env.TAG_CONCURRENCY) || 3,
    whilePlaying: process.env.WHILE_PLAYING === 'pause' ? 'pause' : 'slow' },
  notCopy: [path.resolve(DATA_DIR), MUSIC_DIR && path.resolve(MUSIC_DIR)]
} });
const auth = createAuth({ db, getInfo, setInfo, legacyToken: TOKEN, log: msg => console.log(`[pairing] ${msg}`) });

// ---------- backups (backups.js, archive.js) ----------
const backups = createBackups({
  db, dir: BACKUP_DIR, getCfg: () => settings.effective().backups, checkMs: num(process.env.BACKUP_CHECK_MS, 5 * 60 * 1000),
  getInfo, setInfo, epoch: EPOCH, getMaxSeq: () => maxSeq, serverVersion: SERVER_VERSION, log: msg => console.log(`[backup] ${msg}`)
});
function pruneTombstones() {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  try {
    const a = stmts.corePrune.run(cutoff).changes, b = stmts.energyPrune.run(cutoff).changes;
    if (a || b) console.log(`Pruned tombstones: core=${a} energy=${b}`);
  } catch (e) { console.error('Prune failed:', e.message); }
}
setInterval(pruneTombstones, 10 * 60 * 1000).unref();

// ---------- SSE ----------
const sseClients = new Set();   // responses; res.deviceId: whose
function broadcast(kind) {
  const msg = `data: ${JSON.stringify({ maxSeq, kind: kind || 'core' })}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch (e) { sseClients.delete(res); } }
}
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); } } }, 25000).unref();
const closeStreamsOf = who => { for (const res of sseClients) if (who(res)) { sseClients.delete(res); try { res.end(); } catch (e) {} } };

// ---------- presence (memory only) ----------
let activeDevice = null;

// ---------- Telegram (through this server), updates, discovery ----------
// Telegram: the bridge built into this image (telegram-runner.js), started by the server once it has a
// Telegram app ID (each user's own: entered in Uzikext, Sync → On the server → Telegram, or TG_API_ID and
// TG_API_HASH); or a bridge elsewhere, when TELEGRAM_BRIDGE_URL says where ("off": no Telegram).
const bundled = bundledBridge(__dirname);
const TG_ENV_URL = process.env.TELEGRAM_BRIDGE_URL || '';
const TG_PORT = Number(process.env.TELEGRAM_PORT) || 8788;
let BRIDGE_TOKEN = getInfo('bridge_token');
if (!BRIDGE_TOKEN) { BRIDGE_TOKEN = crypto.randomBytes(24).toString('hex'); setInfo('bridge_token', BRIDGE_TOKEN); }
let tgMode = 'off', bridgeRunner = null, tgRunningWith = null, tgSwitching = Promise.resolve();
var tg = createTgProxy({ url: 'off', token: '', log: msg => console.log(`[telegram] ${msg}`) });
function applyTelegram() {
  tgSwitching = tgSwitching.then(async () => {
    if (TG_ENV_URL) {
      if (tgRunningWith === 'env') return;
      tgRunningWith = 'env'; tgMode = TG_ENV_URL === 'off' ? 'off' : 'external';
      tg.reconfigure({ url: TG_ENV_URL, token: process.env.TELEGRAM_BRIDGE_TOKEN || TOKEN });
      return;
    }
    const t = settings.effective().telegram;
    // (the sync settings are part of it: a change restarts the bridge, which stays signed in; not the default scan
    // depth: Uzikext tells the running bridge, which starts reading back)
    const key = bundled && t.apiId && t.apiHash ? `${t.apiId}:${t.apiHash}:${t.refreshMinutes}:${t.tagConcurrency}:${t.whilePlaying}` : '';
    if (key === tgRunningWith) return;
    tgRunningWith = key;
    if (bridgeRunner) { const r = bridgeRunner; bridgeRunner = null; await r.stop(); }
    if (!bundled) { tgMode = 'off'; tg.reconfigure({ url: 'off' }); return; }
    if (!key) { tgMode = 'needs-app-id'; tg.reconfigure({ url: 'off' }); return; }
    tgMode = 'built-in';
    tg.reconfigure({ url: `http://127.0.0.1:${TG_PORT}`, token: BRIDGE_TOKEN });
    bridgeRunner = startBridge({ dir: bundled, python: process.env.TELEGRAM_PYTHON || '/opt/tg/bin/python', dataDir: path.join(DATA_DIR, 'telegram'), port: TG_PORT,
      token: BRIDGE_TOKEN, apiId: t.apiId, apiHash: t.apiHash, log: msg => console.log(`[telegram] ${msg}`), onReady: () => tg.probe(),
      env: { REFRESH_MINUTES: String(t.refreshMinutes), SCAN_YEARS: String(t.scanYears), TAG_CONCURRENCY: String(t.tagConcurrency), WHILE_PLAYING: t.whilePlaying } });
    console.log(`[telegram] the built-in bridge, Telegram app ${t.apiId} (data in ${path.join(DATA_DIR, 'telegram')})`);
  }).catch(e => console.error('[telegram]', e.message));
  return tgSwitching;
}
for (const sig of ['SIGTERM', 'SIGINT']) process.prependListener(sig, () => { if (bridgeRunner) bridgeRunner.stop(); });
applyTelegram();
settings.onChange(() => applyTelegram());
const tgState = () => { const t = settings.effective().telegram; return { ...tg.state(), mode: tgMode, needsAppId: tgMode === 'needs-app-id', appId: t.apiId || null, appIdFrom: t.from, runner: bridgeRunner ? bridgeRunner.state() : null }; };
const updates = startUpdateCheck({ repo: process.env.UPDATE_REPO || '', current: SERVER_RELEASE, log: msg => console.log(`[update] ${msg}`) });
// ---------- controller presets: kept in the info table, as one list ----------
const ctlPresets = (() => {
  const KEY = 'controller_presets', MAX_PRESETS = 200, MAX_ONE = 512 * 1024;
  const read = () => { try { const a = JSON.parse(getInfo(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const write = a => setInfo(KEY, JSON.stringify(a));
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const legacyN = s => s.legacy ? Object.keys(s.legacy.shortcuts || {}).length + Object.keys(s.legacy.vibeKeys || {}).length : 0;
  function clean(x) {
    if (!isObj(x)) throw new Error('no preset');
    const name = String(x.name || '').trim().slice(0, 80);
    if (!name) throw new Error('a preset needs a name');
    if (!Array.isArray(x.sources) || !x.sources.length || x.sources.length > 64) throw new Error('a preset needs its sources');
    const sources = x.sources.map(s => {
      if (!isObj(s) || !Array.isArray(s.mappings) || s.mappings.length > 4000 || !s.mappings.every(isObj)) throw new Error('bad source in the preset');
      return { model: String(s.model || '').slice(0, 120), name: String(s.name || '').slice(0, 120), kbd: !!s.kbd, mappings: s.mappings, ...(isObj(s.legacy) ? { legacy: s.legacy } : {}) };
    });
    const out = { v: 1, id: String(x.id || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomBytes(6).toString('hex'), name, kind: x.kind === 'source' ? 'source' : 'all', savedAt: Date.now(), sources };
    if (JSON.stringify(out).length > MAX_ONE) throw new Error('that preset is too big');
    return out;
  }
  return {
    list: () => read().map(({ id, name, kind, savedAt, sources }) => ({ id, name, kind, savedAt, count: sources.reduce((n, s) => n + s.mappings.length + legacyN(s), 0), sources: sources.map(s => ({ model: s.model, name: s.name, kbd: s.kbd, count: s.mappings.length + legacyN(s) })) })),
    get: id => read().find(p => p.id === id) || null,
    save(x) {
      const p = clean(x), all = read();
      // (the same name and kind replaces the older one)
      const i = all.findIndex(o => o.name.toLowerCase() === p.name.toLowerCase() && o.kind === p.kind && JSON.stringify(o.sources.map(s => s.model + '|' + s.kbd)) === JSON.stringify(p.sources.map(s => s.model + '|' + s.kbd)));
      if (i >= 0) { p.id = all[i].id; all[i] = p; } else { if (all.length >= MAX_PRESETS) throw new Error('too many presets: remove one'); all.push(p); }
      write(all);
      return { id: p.id, name: p.name, savedAt: p.savedAt };
    },
    remove(id) { write(read().filter(p => p.id !== id)); }
  };
})();
const identity = () => ({ id: SERVER_ID, name: settings.effective().name, version: SERVER_VERSION, release: SERVER_RELEASE });
if (process.env.MDNS !== 'off') startDiscovery({ port: PORT, getIdentity: identity, log: msg => console.log(`[discovery] ${msg}`) });

// ---------- http plumbing ----------
// explosiveness_metrics is stored as JSON text (see the v2.7 migration comment above) — safe to parse
// back into the {m01..m09} object every response site needs; malformed/absent data just reads as null
// rather than throwing, same spirit as every other "not computed yet" field in these responses.
function parseExplosivenessMetrics(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

// (res.cors: the CORS headers for this request's origin, netguard.js)
function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...res.cors });
  res.end(json);
}
function tokenOf(req, url) {
  const m = (req.headers['authorization'] || '').match(/^Bearer (.+)$/);
  return m ? m[1].trim() : url.searchParams.get('token');
}
const clientIp = req => String(req.socket.remoteAddress || '').replace(/^::ffff:(?=\d)/, '');
function readJson(req, res, cb) {
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => {
    if (tooBig) return;
    size += c.length;
    if (size > MAX_BODY) { tooBig = true; send(res, 413, { error: 'payload too large', maxBytes: MAX_BODY }); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return;
    let body;
    try {
      let buf = Buffer.concat(chunks);
      if (/gzip/i.test(req.headers['content-encoding'] || '')) buf = zlib.gunzipSync(buf);
      body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch (e) { return send(res, 400, { error: 'invalid JSON: ' + e.message }); }
    try { cb(body || {}); }
    catch (e) { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); }
  });
}
// a raw body (an uploaded archive) -> Buffer
function readRaw(req, res, max, cb) {
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => {
    if (tooBig) return;
    size += c.length;
    if (size > max) { tooBig = true; send(res, 413, { error: 'file too large', maxBytes: max }); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!tooBig) cb(Buffer.concat(chunks)); });
}
function afterWrite(res, body, kind) {
  send(res, 200, body);
  broadcast(kind);
}

// ---------- background analysis: started, and started again when its settings or music folders change ----------
let analysisScheduler = null;
let musicMatch = null, matching = null;
// what holds the background analysis back (the app says: 'dvs', 'battery', 'busy'), renewed by the app;
// forgotten after 2 minutes without news
let holds = { reasons: [], at: 0 };
const heldBy = () => (Date.now() - holds.at < 120000 ? holds.reasons : []);
const rootsNow = () => settings.effective().music.roots || (musicMatch ? musicMatch.roots.map(r => ({ name: r.name, dir: r.dir })) : []);
let runningWith = '';
function applyAnalysis() {
  const a = settings.effective().analysis, roots = rootsNow();
  const key = JSON.stringify({ a, roots });
  if (key === runningWith) return;
  runningWith = key;
  if (analysisScheduler) { analysisScheduler.stop(); analysisScheduler = null; }
  if (!roots.length) return;
  analysisScheduler = startAnalysisScheduler({
    db, energyUpsertStmt: stmts.energyUpsert, energyGetStmt: stmts.energyGet, energyMarkSkippedStmt: stmts.energyMarkSkipped,
    coreGetStmt: stmts.coreGetFull, coreUpsertStmt: stmts.coreUpsert, nextSeq,
    roots, heldBy, paceMs: a.paceMs, rescanMs: a.rescanMs, concurrency: a.concurrency, maxDurationSec: a.maxDurationSec,
    log: msg => console.log(`[analysis] ${msg}`), broadcast,
  });
  console.log(`[analysis] music: ${roots.map(r => `${r.dir} as "${r.name}"`).join(', ')}; ${a.concurrency} at a time, ${a.paceMs} ms apart, max ${a.maxDurationSec ? a.maxDurationSec + ' s' : 'any length'}`);
}
function rematch() {
  if (!MUSIC_DIR) return Promise.resolve(null);
  if (matching) return matching;
  matching = matchMusic(db, MUSIC_DIR).then(m => {
    const was = musicMatch && JSON.stringify(musicMatch.roots.map(r => [r.name, r.dir]));
    musicMatch = m;
    if (JSON.stringify(m.roots.map(r => [r.name, r.dir])) !== was) {
      console.log(m.roots.length ? `[music] found: ${m.roots.map(r => `"${r.name}" = ${r.dir} (${r.found}/${r.tried} tracks there)`).join(', ')}`
        : `[music] ${m.error || `no folder of ${MUSIC_DIR} matches the devices' folders yet${m.unmatched.length ? ` (${m.unmatched.map(u => `"${u.name}"`).join(', ')})` : ''}`}`);
    }
    applyAnalysis();
    return m;
  }).catch(e => { console.error('[music] matching failed:', e.message); return null; }).finally(() => { matching = null; });
  return matching;
}
let rematchTimer = null;
const rematchSoon = () => { clearTimeout(rematchTimer); rematchTimer = setTimeout(rematch, 15000); rematchTimer.unref(); };
settings.onChange((now, before) => {
  if (JSON.stringify(now.backups.copyDir) !== JSON.stringify(before.backups.copyDir)) {
    EPOCH_FILES[1] = copyEpochFile(now.backups.copyDir); epochSaved[1] = { seq: -1, at: 0 };
    backups.catchUpCopy(); saveEpochFiles(true);
  }
  applyAnalysis();
});

function analysisState() {
  const st = analysisScheduler ? analysisScheduler.getStats() : null;
  return st;
}
function musicState() {
  const manual = settings.effective().music.roots;
  return { dir: MUSIC_DIR || null, manual: !!manual, roots: rootsNow(), match: musicMatch };
}
function fullSettings() {
  const e = settings.effective();
  const st = settings.stored().telegram || {};
  const shown = { ...e, telegram: { apiId: e.telegram.apiId || null, from: e.telegram.from, hasHash: !!e.telegram.apiHash,
    refreshMinutes: e.telegram.refreshMinutes, scanYears: e.telegram.scanYears, tagConcurrency: e.telegram.tagConcurrency, whilePlaying: e.telegram.whilePlaying,
    syncFrom: Object.fromEntries(['refreshMinutes', 'scanYears', 'tagConcurrency', 'whilePlaying'].map(k => [k, st[k] != null ? 'panel' : process.env[{ refreshMinutes: 'REFRESH_MINUTES', scanYears: 'SCAN_YEARS', tagConcurrency: 'TAG_CONCURRENCY', whilePlaying: 'WHILE_PLAYING' }[k]] ? 'env' : 'default'])),
    bridge: tgMode } };
  return { settings: shown, defaults: null, music: musicState(), mounts: mounts([path.resolve(DATA_DIR), MUSIC_DIR && path.resolve(MUSIC_DIR)]),
    network: { allowFrom: guard.mode, bind: BIND || 'all' }, mode: SERVER_MODE, legacyToken: auth.legacy(), telegram: tgState(), update: updates.state() };
}

const firstRun = () => auth.deviceCount() === 0 && auth.legacy() !== 'on';

// ---------- requests ----------
const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  res.cors = guard.cors(req);
  if (!guard.allowed(ip)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('This Uzikext server only answers its home network (ALLOW_FROM).');
  }
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...res.cors, 'Access-Control-Max-Age': '600' }); return res.end(); }

  // ----- no key needed -----
  if ((p === '/' || p === '/status' || p === '/pair') && req.method === 'GET') {
    const a = analysisState(), m = musicState(), t = tgState();
    const html = statusPage({
      name: settings.effective().name, release: SERVER_RELEASE, address: `http://${req.headers.host || 'this-server:' + PORT}`,
      devices: auth.deviceCount(), update: updates.state(), firstRun: firstRun(),
      music: m.roots.length ? m.roots.map(r => `${r.dir} as "${r.name}"`).join(', ') : (MUSIC_DIR ? `${MUSIC_DIR}: not matched with your devices' folders yet (add your music folder in Uzikext)` : 'none mounted (/music)'),
      analysis: !a ? 'off (no music folder)' : `${a.enabled ? 'on' : 'paused'} · ${(a.totalKnown - a.queueLength).toLocaleString()} of ${a.totalKnown.toLocaleString()} tracks analysed${a.gridsQueued ? ` · ${a.gridsQueued.toLocaleString()} beat grids to do` : ''}`,
      telegram: t.needsAppId ? 'waiting for your Telegram app ID (Uzikext → ⋮ → Library → Telegram → App ID)' : !t.configured ? 'off' : t.reachable ? (t.authorized ? 'signed in' : 'bridge running, not signed in') : t.reachable === false ? `bridge not reachable${t.error ? ' (' + t.error + ')' : ''}` : '…'
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
    return res.end(html);
  }
  // ----- the Uzikext app this server runs in (this computer only, with its admin key) -----
  if (p.startsWith('/local/')) {
    const loopback = /^(127\.|::1$)/.test(ip);
    const key = req.headers['x-local-admin'] || '';
    if (!LOCAL_ADMIN_KEY || !loopback || key.length !== LOCAL_ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(LOCAL_ADMIN_KEY))) return send(res, 403, { error: 'forbidden' });
    return readJson(req, res, body => {
      if (p === '/local/pair') return send(res, 200, { ok: true, ...auth.local(body.name, body.platform), server: identity() });
      if (p === '/local/config') {
        const patch = {};
        if ('musicRoots' in body) patch.music = { roots: Array.isArray(body.musicRoots) && body.musicRoots.length ? body.musicRoots : [] };
        if ('copyDir' in body) patch.backups = { copyDir: body.copyDir || '' };
        if (typeof body.name === 'string') patch.name = body.name;
        try { settings.update(patch, { trusted: true }); } catch (e) { return send(res, 400, { error: e.message }); }
        return send(res, 200, fullSettings());
      }
      if (p === '/local/hold') {
        holds = { reasons: (Array.isArray(body.reasons) ? body.reasons : []).map(String).slice(0, 8), at: Date.now() };
        return send(res, 200, { ok: true, held: heldBy() });
      }
      send(res, 404, { error: 'not found' });
    });
  }
  const who = auth.check(tokenOf(req, url), ip);
  if (p === '/health' && req.method === 'GET') {
    const base = { ok: true, app: 'uzikext', ...identity(), paired: !!who };
    if (!who) return send(res, 200, base);
    const c = stmts.counts.get();
    return send(res, 200, { ...base, epoch: EPOCH, maxSeq, core: c.core, energy: c.energy, analysis: analysisState(), music: musicState(),
      device: who.kind === 'device' ? who.device : null, legacyToken: auth.legacy(), telegram: tgState(), update: updates.state(), devices: auth.deviceCount() });
  }
  if (p === '/pair' && req.method === 'POST') {
    return readJson(req, res, body => {
      try {
        const r = auth.pair(body.code, body.name, body.platform, ip);
        send(res, 200, { ok: true, ...r, server: identity() });
      } catch (e) { send(res, e.status || 400, { error: e.message }); }
    });
  }
  if (p === '/pair/page-code' && req.method === 'POST') {
    req.resume();
    const c = auth.makeCode('page');
    const until = new Date(c.expires).toLocaleTimeString();
    // shown on the page only on a fresh server (nothing paired, no shared token): the first device claims it
    if (firstRun()) { console.log(`[pairing] Pairing code (status page): ${c.code} — valid until ${until}`); return send(res, 200, { code: c.code, expires: c.expires }); }
    console.log(`[pairing] Pairing code: ${c.code} — valid until ${until}, for one device (asked from the status page)`);
    return send(res, 200, { inLog: true, expires: c.expires });
  }
  if (!who) return send(res, 401, { error: 'unauthorized' });
  const myDevice = who.kind === 'device' ? who.device.id : null;

  // ----- devices -----
  if (p === '/pair/code' && req.method === 'POST') {
    req.resume();
    const c = auth.makeCode(myDevice || 'token');
    console.log(`[pairing] Pairing code made by ${who.kind === 'device' ? `"${who.device.name}"` : 'the shared token'}, valid 10 minutes`);
    const lan = BIND && /^127\.|^localhost$/.test(BIND) ? [] : localV4().map(a => `http://${a}:${PORT}`);
    return send(res, 200, { code: c.code, expires: c.expires, addresses: lan });
  }
  if (p === '/pair/upgrade' && req.method === 'POST') {
    return readJson(req, res, body => {
      if (who.kind !== 'legacy') return send(res, 400, { error: 'this device has a key already' });
      send(res, 200, { ok: true, ...auth.upgrade(body.name, body.platform, ip), server: identity() });
    });
  }
  if (p === '/devices' && req.method === 'GET') return send(res, 200, { devices: auth.list(), you: myDevice, legacyToken: auth.legacy() });
  if (p === '/devices/remove' && req.method === 'POST') {
    return readJson(req, res, body => {
      const id = String(body.id || '');
      const ok = auth.remove(id);
      if (ok) closeStreamsOf(r => r.deviceId === id);
      send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such device' });
    });
  }
  if (p === '/devices/rename' && req.method === 'POST') {
    return readJson(req, res, body => { const ok = auth.rename(body.id || myDevice, body.name); send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such device' }); });
  }
  if (p === '/server/legacy-token' && req.method === 'POST') {
    return readJson(req, res, body => {
      if (auth.legacy() === 'unset') return send(res, 400, { error: 'no shared token is set (SYNC_TOKEN)' });
      if (!body.on && who.kind === 'legacy') return send(res, 400, { error: 'this device still uses the shared token: it gets a key of its own first' });
      auth.setLegacy(!!body.on);
      if (!body.on) closeStreamsOf(r => r.deviceId === null);
      console.log(`[pairing] The old shared token is now ${body.on ? 'accepted' : 'refused'}`);
      send(res, 200, { ok: true, legacyToken: auth.legacy() });
    });
  }

  // ----- the server's settings -----
  if (p === '/server/settings' && req.method === 'GET') return send(res, 200, fullSettings());
  if (p === '/server/settings' && req.method === 'POST') {
    return readJson(req, res, body => {
      try { settings.update(body); } catch (e) { return send(res, 400, { error: e.message }); }
      send(res, 200, fullSettings());
    });
  }
  if (p === '/server/music/match' && req.method === 'POST') {
    req.resume();
    return rematch().then(() => send(res, 200, fullSettings()), e => send(res, 500, { error: e.message }));
  }

  // ----- Telegram -----
  if (p.startsWith('/tg/')) return tg.forward(req, res, p.slice(3) + url.search, res.cors);

  // ----- controller presets (Uzikext → Controllers: a saved set of mappings, for all controllers or one) -----
  if (p === '/controller-presets' && req.method === 'GET') return send(res, 200, { presets: ctlPresets.list() });
  if (p === '/controller-presets' && req.method === 'POST') {
    return readJson(req, res, body => {
      try { return send(res, 200, { ok: true, preset: ctlPresets.save(body.preset), presets: ctlPresets.list() }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    });
  }
  if (p === '/controller-presets/get' && req.method === 'POST') {
    return readJson(req, res, body => { const x = ctlPresets.get(String(body.id || '')); return x ? send(res, 200, { preset: x }) : send(res, 404, { error: 'no such preset' }); });
  }
  if (p === '/controller-presets/delete' && req.method === 'POST') {
    return readJson(req, res, body => { ctlPresets.remove(String(body.id || '')); send(res, 200, { ok: true, presets: ctlPresets.list() }); });
  }

  // ----- sync -----
  if (p === '/changes' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since')) || 0;
    const kinds = url.searchParams.get('kinds') || 'core';
    const limit = Math.min(CHANGES_LIMIT_MAX, Number(url.searchParams.get('limit')) || 2000);
    let rows;
    if (kinds === 'energy') rows = stmts.energyChanges.all(since, limit + 1).map(r => ({ path: r.path, ts: r.ts, intensity: r.intensity, bpm: r.bpm, bpmSource: r.bpm_source,
      melodicScore: r.melodic_score, melodicHarmonicity: r.melodic_harmonicity, melodicMovement: r.melodic_movement,
      subHz: r.sub_hz, subQuality: r.sub_quality, explosivenessMetrics: parseExplosivenessMetrics(r.explosiveness_metrics), deleted: !!r.deleted, seq: r.seq }));
    else rows = stmts.coreChanges.all(since, limit + 1).map(r => ({ kind: r.kind, key: r.key, ts: r.ts, removed: !!r.removed, payload: JSON.parse(r.payload), seq: r.seq }));
    const more = rows.length > limit;
    if (more) rows.length = limit;
    const cursor = rows.length ? rows[rows.length - 1].seq : since;
    return send(res, 200, { rows, cursor, more, maxSeq, epoch: EPOCH });
  }

  if (p === '/changes' && req.method === 'POST') {
    return readJson(req, res, body => {
      const rows = Array.isArray(body.core) ? body.core : [];
      const r = applyCoreRows(rows);
      afterWrite(res, { ok: true, maxSeq, ...r });
      // a device's folder list changed: look for the music folders again
      if (MUSIC_DIR && rows.some(x => x && x.kind === 'settings' && typeof x.key === 'string' && x.key.startsWith('connectedFolders:'))) rematchSoon();
    });
  }

  if (p === '/energy' && req.method === 'GET') {
    const row = stmts.energyGet.get(url.searchParams.get('path') || '');
    if (!row || row.deleted || !row.blob) return send(res, 404, { error: 'not found' });
    return send(res, 200, { path: row.path, ts: row.ts, intensity: row.intensity, bpm: row.bpm, bpmSource: row.bpm_source,
      melodicScore: row.melodic_score, melodicHarmonicity: row.melodic_harmonicity, melodicMovement: row.melodic_movement,
      subHz: row.sub_hz, subQuality: row.sub_quality, explosivenessMetrics: parseExplosivenessMetrics(row.explosiveness_metrics),
      blob: Buffer.from(row.blob).toString('base64') });
  }

  if (p === '/energy/fetch' && req.method === 'POST') {
    return readJson(req, res, body => {
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500) : [];
      const rows = [];
      for (const q of paths) {
        const row = stmts.energyGet.get(String(q));
        if (row && !row.deleted && row.blob) rows.push({ path: row.path, ts: row.ts, intensity: row.intensity, bpm: row.bpm, bpmSource: row.bpm_source,
          melodicScore: row.melodic_score, melodicHarmonicity: row.melodic_harmonicity, melodicMovement: row.melodic_movement,
          subHz: row.sub_hz, subQuality: row.sub_quality, explosivenessMetrics: parseExplosivenessMetrics(row.explosiveness_metrics),
          blob: Buffer.from(row.blob).toString('base64') });
      }
      send(res, 200, { rows });
    });
  }

  if (p === '/energy' && req.method === 'POST') {
    return readJson(req, res, body => {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const r = applyEnergyRows(rows);
      afterWrite(res, { ok: true, maxSeq, ...r }, 'energy');
    });
  }

  if (p === '/energy/delete' && req.method === 'POST') {
    return readJson(req, res, body => {
      const n = deleteEnergyPaths(Array.isArray(body.paths) ? body.paths : [], Number(body.ts) || Date.now());
      afterWrite(res, { ok: true, maxSeq, deleted: n }, 'energy');
    });
  }

  if (p === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...res.cors });
    res.write(`data: ${JSON.stringify({ maxSeq, epoch: EPOCH })}\n\n`);
    res.deviceId = myDevice;
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/presence' && req.method === 'GET') return send(res, 200, activeDevice || { deviceId: null, deviceName: null, ts: 0 });
  if (p === '/presence' && req.method === 'POST') {
    return readJson(req, res, body => {
      activeDevice = { deviceId: String(body.deviceId || ''), deviceName: String(body.deviceName || ''), ts: Date.now() };
      send(res, 200, activeDevice);
    });
  }

  if (p === '/backups' && req.method === 'GET') return send(res, 200, { ...backups.list(), epoch: EPOCH });

  if (p === '/backups/info' && req.method === 'GET') {
    const name = url.searchParams.get('name') || '';
    const file = backups.fileOf(name);
    if (!file) return send(res, 404, { error: 'no such backup' });
    try {
      const d = describeArchive(fs.readFileSync(file), name);
      const src = d.manifest.source || {};
      const since = src.epoch === EPOCH && Number.isFinite(src.maxSeq) ? db.prepare('SELECT COUNT(*) AS n FROM core WHERE seq > ?').get(src.maxSeq).n : null;
      return send(res, 200, { name, created: d.manifest.createdMs || Date.parse(d.manifest.created) || 0, scope: d.manifest.scope, reason: d.manifest.reason,
        live: d.live, analysis: d.analysis, changedSince: since, thisDatabase: src.epoch === EPOCH });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  if (p === '/backups/now' && req.method === 'POST') {
    return readJson(req, res, body => {
      const scope = body && body.scope === 'data' ? 'data' : 'full';
      backups.make(scope, 'manual').then(r => send(res, 200, { ok: true, ...r }), e => send(res, 500, { error: e.message }));
    });
  }

  if (p === '/backups/file' && req.method === 'GET') {
    const name = url.searchParams.get('name') || '';
    const file = backups.fileOf(name);
    if (!file) return send(res, 404, { error: 'no such backup' });
    const st = fs.statSync(file);
    res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/zip', 'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${name}"`, ...res.cors });
    return fs.createReadStream(file).pipe(res);
  }

  // Restore (merge, see archive.js): from one of the backups (?name=) or an uploaded archive (the body).
  // Everything as it is now is archived first (…-before-restore.uzx), so a restore can itself be undone.
  if (p === '/backups/restore' && req.method === 'POST') {
    const name = url.searchParams.get('name');
    const run = async (buf, label) => {
      const arc = openArchive(buf, label);
      // undoing a restore: what that restore wrote (recorded below, keyed by its "before" archive)
      const src = arc.manifest.source || {};
      const undoRec = arc.manifest.reason === 'before-restore' && src.epoch === EPOCH ? getInfo(`undo:${src.maxSeq}`) : null;
      const undo = undoRec ? JSON.parse(undoRec) : null;
      const before = await backups.make('full', 'before-restore');
      const seqStart = maxSeq;
      let r;
      try { r = restoreArchive(db, arc, { nextSeq, stmts, epoch: EPOCH, undo }); }
      catch (e) { maxSeq = seqStart; throw e; }   // (rolled back: nothing was written)
      if (maxSeq > seqStart) setInfo(`undo:${before.maxSeq}`, JSON.stringify({ from: seqStart + 1, to: maxSeq }));
      console.log(`[backup] Restored ${label}: ${JSON.stringify(r)} (before: ${before.name})`);
      broadcast('core'); broadcast('energy');
      return { ok: true, ...r, from: { created: arc.manifest.created, scope: arc.manifest.scope, source: arc.manifest.source }, before: before.name, maxSeq };
    };
    const fail = e => send(res, 400, { error: e.message });
    if (name) {
      const file = backups.fileOf(name);
      if (!file) return send(res, 404, { error: 'no such backup' });
      req.resume();
      return run(fs.readFileSync(file), name).then(r => send(res, 200, r), fail);
    }
    return readRaw(req, res, BACKUP_UPLOAD_MAX, buf => run(buf, 'the uploaded file').then(r => send(res, 200, r), fail));
  }

  // (the old full-state export is gone: backups are archives now)
  if (p === '/state') return send(res, 410, { error: 'gone: backups are Uzikext archives now (GET /backups)' });

  send(res, 404, { error: 'not found' });
});

// the music folders: found at start, looked for again every 30 minutes and when a device's folders change
if (settings.effective().music.roots) applyAnalysis();
if (MUSIC_DIR) { setTimeout(rematch, 3000).unref(); setInterval(rematch, ANALYSIS_RESCAN_MS).unref(); }

server.on('error', e => { console.error(`Can't listen on port ${PORT}: ${e.message}`); process.exit(3); });
server.listen(PORT, BIND, () => {
  const c = stmts.counts.get(), e = settings.effective();
  console.log(`Uzikext server ${SERVER_RELEASE} ("${e.name}", id ${SERVER_ID}) listening on :${PORT} — core=${c.core} energy=${c.energy} maxSeq=${maxSeq} epoch=${EPOCH}`);
  if (SERVER_MODE === 'app') console.log(`[app] inside the Uzikext app, ${BIND && /^127\./.test(BIND) ? 'for this computer only' : 'for the other devices of the home network too'}`);
  console.log(`[network] answering ${guard.mode === 'home' ? 'the home network only' : guard.mode === 'any' ? 'every address (ALLOW_FROM=any)' : 'the home network and ' + process.env.ALLOW_FROM}`);
  console.log(`[pairing] ${auth.deviceCount()} device(s) paired; the old shared token: ${auth.legacy()}`);
  if (auth.deviceCount() === 0 && auth.legacy() !== 'on') {
    const code = auth.makeCode('log');
    console.log(`[pairing] No device paired yet. Pairing code: ${code.code} (valid 10 minutes; a new one: the status page, http://<this server>:${PORT})`);
  }
  console.log(`[backup] ${e.backups.hourly ? 'hourly data' : 'no hourly'} / ${e.backups.daily ? 'daily full' : 'no daily'} archives in ${BACKUP_DIR}${e.backups.copyDir ? `, copied to ${e.backups.copyDir}` : ' (no copy folder set)'}`);
  if (!MUSIC_DIR) console.log('[analysis] no music folder mounted (/music): background analysis is off');
  if (tgMode === 'needs-app-id') console.log('[telegram] waiting for a Telegram app ID (Uzikext → Sync → On the server → Telegram)');
  else if (tgMode !== 'built-in') console.log(`[telegram] ${tgMode === 'off' ? 'off' : 'the bridge at ' + TG_ENV_URL}`);
});
