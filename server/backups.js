// The server's backups: Uzikext archives (archive.js) made on a schedule, kept by a rotation, and copied to
// a second place off the server's own disk.
//
//   every hour (when something changed)   your data                    uzikext-data-<time>-hourly.uzx
//   every day  (when something changed)   your data + all the analysis uzikext-full-<time>-daily.uzx
//   from Uzikext ("Back up now")          either                       …-manual.uzx
//   before every restore                  everything, as it was        uzikext-full-<time>-before-restore.uzx
//
// Kept: the last 48 hourly ones (2 days); daily ones: the last 14 days, plus the last of each of the last
// 8 weeks and of each of the last 12 months; the last 10 made by hand, and the last 10 before a restore. All
// settable. Each name ends with the database's identity (epoch): only this database's archives are rotated;
// another one's (from before a lost disk) are never removed automatically.
//
// The copy (BACKUP_COPY_DIR): a second folder, ideally on another disk or machine (another NAS share, a USB
// drive, a folder synced to the cloud). Every archive is copied there as it's made, and anything missing
// there is copied over at start; the same rotation applies there. If it can't be written, Uzikext's settings
// says so.
const fs = require('fs');
const path = require('path');
const { writeServerArchive } = require('./archive.js');

// uzikext-<scope>-<yyyymmdd>-<hhmmss>-<reason>-<the database's epoch, 8 characters>.uzx
const NAME_RE = /^uzikext-(data|full)-(\d{8})-(\d{6})-([a-z]+(?:-[a-z]+)*?)(?:-([0-9a-f]{8}))?\.uzx$/;
const stampOf = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);   // 20261010-031500
const dateOf = (ymd, hms) => new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4)}Z`);

function parseName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { name, scope: m[1], reason: m[4], epoch: m[5] || '', at: dateOf(m[2], m[3]).getTime() };
}

function listArchives(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const p = parseName(n);
    if (!p) continue;
    try { p.size = fs.statSync(path.join(dir, n)).size; } catch (e) { continue; }
    out.push(p);
  }
  return out.sort((a, b) => b.at - a.at);
}

// ISO week key of a time (UTC)
function weekKey(ms) {
  const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const y = d.getUTCFullYear(), w1 = new Date(Date.UTC(y, 0, 4));
  return y + '-W' + (1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7));
}
const monthKey = ms => new Date(ms).toISOString().slice(0, 7);

// Which archives a rotation keeps (newest first in, a Set of names out)
function toKeep(list, keep) {
  const kept = new Set();
  const hourly = list.filter(a => a.reason === 'hourly');
  hourly.slice(0, keep.hourly).forEach(a => kept.add(a.name));
  const daily = list.filter(a => a.reason === 'daily');
  daily.slice(0, keep.daily).forEach(a => kept.add(a.name));
  for (const [keyOf, n] of [[weekKey, keep.weekly], [monthKey, keep.monthly]]) {
    const seen = new Set();
    for (const a of daily) {   // newest first: the first one met in a week / month is its last
      const k = keyOf(a.at);
      if (seen.has(k)) continue;
      if (seen.size >= n) break;
      seen.add(k); kept.add(a.name);
    }
  }
  list.filter(a => a.reason === 'manual').slice(0, keep.manual).forEach(a => kept.add(a.name));
  list.filter(a => a.reason === 'before-restore').slice(0, keep.beforeRestore ?? keep.manual).forEach(a => kept.add(a.name));
  list.filter(a => !['hourly', 'daily', 'manual', 'before-restore'].includes(a.reason)).forEach(a => kept.add(a.name));
  return kept;
}

// Only this database's own archives are rotated: those of another one (from before a lost disk, in the copy
// folder or here) are never removed automatically.
function rotate(dir, keep, log, epoch8) {
  const list = listArchives(dir).filter(a => a.epoch === epoch8), kept = toKeep(list, keep);
  for (const a of list) {
    if (kept.has(a.name)) continue;
    try { fs.unlinkSync(path.join(dir, a.name)); } catch (e) { log(`Couldn't remove old backup ${a.name}: ${e.message}`); }
  }
}

// getCfg() -> { keep, hourlyMs, dailyMs, hourly, daily, copyDir }: read each time (Uzikext's settings change them)
function createBackups({ db, dir, getCfg, checkMs = 5 * 60 * 1000, getInfo, setInfo, epoch, getMaxSeq, serverVersion, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const epoch8 = String(epoch).slice(0, 8);
  const copy = { dir: getCfg().copyDir || null, ok: null, lastAt: 0, lastError: null };
  const cfg = () => { const c = getCfg(); if ((c.copyDir || null) !== copy.dir) Object.assign(copy, { dir: c.copyDir || null, ok: null, lastAt: 0, lastError: null }); return c; };
  let busy = Promise.resolve();
  const serial = fn => { const run = busy.then(fn, fn); busy = run.catch(() => {}); return run; };

  // the copy folder must exist already (it's a mount): it isn't created here, so an unplugged drive's empty
  // mount point isn't silently filled instead
  const copyReady = copyDir => {
    if (!fs.existsSync(copyDir) || !fs.statSync(copyDir).isDirectory()) throw new Error(`the copy folder ${copyDir} isn't there (not mounted?)`);
    fs.accessSync(copyDir, fs.constants.W_OK);
  };
  function copyOut(name) {
    const { copyDir, keep } = cfg();
    if (!copyDir) return;
    try {
      copyReady(copyDir);
      const tmp = path.join(copyDir, name + '.tmp');
      fs.copyFileSync(path.join(dir, name), tmp);
      fs.renameSync(tmp, path.join(copyDir, name));
      rotate(copyDir, keep, log, epoch8);
      Object.assign(copy, { ok: true, lastAt: Date.now(), lastError: null });
    } catch (e) {
      Object.assign(copy, { ok: false, lastError: e.message });
      log(`Backup copy to ${copyDir} failed: ${e.message}`);
    }
  }
  // archives the copy doesn't have yet (it was unplugged, or just set up)
  function catchUpCopy() {
    const { copyDir } = cfg();
    if (!copyDir) return;
    let there = new Set();
    try { copyReady(copyDir); there = new Set(fs.readdirSync(copyDir)); }
    catch (e) { Object.assign(copy, { ok: false, lastError: e.message }); return; }
    const missing = listArchives(dir).filter(a => !there.has(a.name)).reverse();
    for (const a of missing) copyOut(a.name);
    if (!missing.length) Object.assign(copy, { ok: true, lastError: null });
  }

  // Makes an archive. scope 'data' | 'full'; reason 'hourly' | 'daily' | 'manual' | 'before-restore'
  function make(scope, reason) {
    return serial(async () => {
      const nameNow = () => `uzikext-${scope}-${stampOf(new Date())}-${reason}-${epoch8}.uzx`;
      let name = nameNow();
      while (fs.existsSync(path.join(dir, name))) {   // (names are to the second: two in the same second wait)
        await new Promise(r => setTimeout(r, 1000 - (Date.now() % 1000) + 5));
        name = nameNow();
      }
      const file = path.join(dir, name), tmp = file + '.tmp';
      const seq = getMaxSeq();
      let manifest;
      try {
        manifest = await writeServerArchive(db, tmp, { scope, reason, epoch, maxSeq: seq, serverVersion });
        fs.renameSync(tmp, file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        log(`Backup failed (${scope}, ${reason}): ${e.message}`);
        throw e;
      }
      for (const sc of scope === 'full' ? ['full', 'data'] : ['data']) {   // (a full one holds the data too)
        setInfo(`last_${sc}_seq`, String(seq));
        setInfo(`last_${sc}_at`, String(Date.now()));
      }
      rotate(dir, cfg().keep, log, epoch8);
      copyOut(name);
      log(`Backup written: ${name} (${(manifest.bytes / 1048576).toFixed(1)} MB)`);
      return { name, size: manifest.bytes, scope, reason, at: manifest.createdMs, counts: manifest.counts, maxSeq: seq };
    });
  }

  // the schedule: an hourly archive of your data and a daily full one, each only when something changed
  async function tick() {
    const seq = getMaxSeq(), now = Date.now(), c = cfg();
    const due = (scope, every) => now - Number(getInfo(`last_${scope}_at`) || 0) >= every && String(seq) !== String(getInfo(`last_${scope}_seq`) || '');
    try {
      if (c.daily && due('full', c.dailyMs)) await make('full', 'daily');
      else if (c.hourly && due('data', c.hourlyMs)) await make('data', 'hourly');
    } catch (e) { /* logged */ }
  }
  setTimeout(() => { catchUpCopy(); tick(); }, Math.min(15000, checkMs)).unref();
  setInterval(tick, checkMs).unref();

  function list() {
    const { hourlyMs, dailyMs, keep, hourly, daily } = cfg();
    const legacy = (() => {
      try { return fs.readdirSync(dir).filter(n => /^(core-.*\.json|full-.*\.db)$/.test(n)).sort().reverse(); } catch (e) { return []; }
    })();
    return {
      archives: listArchives(dir).map(a => ({ name: a.name, scope: a.scope, reason: a.reason, at: a.at, size: a.size, thisDatabase: a.epoch === epoch8 })),
      legacy,
      copy: { ...copy },
      schedule: { hourlyMs, dailyMs, keep, hourly, daily }
    };
  }
  function fileOf(name) {
    if (parseName(name) || /^core-[\w.-]+\.json$/.test(name)) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  return { make, list, fileOf, tick, catchUpCopy };
}

module.exports = { createBackups, toKeep, listArchives, parseName, weekKey };
