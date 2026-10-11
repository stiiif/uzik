// Uzikext archives (.uzx): one format for every backup, made by the server or exported by a device.
//
// A .uzx is a plain zip:
//   manifest.json            what it is: format, version, when, scope, made by whom, counts
//   README.txt               the same, for a person opening it
//   data/<kind>.jsonl        your data, one record per line: {key, ts, removed, payload} — exactly the server's
//                            `core` rows: tags (stars), notes, played, vibes, excluded, bans, meta (track
//                            metadata and your edits, beat-grid corrections included), settings
//   analysis/energy.jsonl    the analysis of each track (the analysed waveform's numbers: intensity, BPM,
//                            melody, sub-bass, explosiveness…), one per line, with blob: [offset, length]
//   analysis/energy.bin      …pointing into this: the analysed waveforms themselves (energy-codec.js)
//   device/…                 only in an export from a device (Export everything): that device's own settings
//                            and stores, to set a computer up exactly as it was
// scope 'data' has data/ only (small, hourly); 'full' has data/ and analysis/.
//
// Restoring (restoreArchive) depends on where the archive comes from: a backup of this database is rolled
// back to (what was added since stays), a "before a restore" backup undoes that restore exactly, and anything
// else (another database's backup, a device's export) is merged by date. The devices take the result through
// the normal sync, with nothing to do on them.
const { createZip, readZip } = require('./zip.js');

const FORMAT = 'uzikext-archive';
const VERSION = 1;
const CORE_KINDS = ['tags', 'notes', 'played', 'excluded', 'vibes', 'meta', 'settings', 'bans'];
const ENERGY_COLS = 'path, ts, intensity, bpm, bpm_source, melodic_score, melodic_harmonicity, melodic_movement, sub_hz, sub_quality, explosiveness_metrics, duration_sec, skip_reason, blob';

const README = (m) => `Uzikext archive
===============
Made ${m.created} by ${m.source.type === 'server' ? 'the sync server' : `${m.source.deviceName || 'a device'} (Export everything)`}.
Scope: ${m.scope === 'full' ? 'your data and the analysis of every track' : 'your data'}.

data/<kind>.jsonl        your data, one record per line ({key, ts, removed, payload}):
                         tags = stars, notes, played, vibes, excluded, bans,
                         meta = track metadata and your edits, settings = shared settings
analysis/energy.jsonl    each track's analysis (intensity, BPM, melody, sub-bass, explosiveness),
analysis/energy.bin      and its analysed waveform (binary, see energy-codec.js)
device/                  (device exports only) that device's own settings and stores

To restore: Uzikext → Sync panel → Backups → Restore (a backup on the server) or
"Restore from a file…" (this file). Everything in it comes back as it was then; what was
added since stays.
`;

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
function parseJsonl(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.split('\n')) { if (line.trim()) out.push(JSON.parse(line)); }
  return out;
}
const parseJson = t => { if (!t) return null; try { return JSON.parse(t); } catch (e) { return null; } };

// Everything an archive holds, read from the database in one go (synchronously: no write can land in
// between, so it's a consistent picture).
function snapshot(db, scope) {
  const data = {};
  for (const k of CORE_KINDS) data[k] = [];
  for (const r of db.prepare('SELECT kind, key, ts, removed, payload FROM core ORDER BY kind, key').all()) {
    if (!data[r.kind]) data[r.kind] = [];
    data[r.kind].push({ key: r.key, ts: r.ts, removed: !!r.removed, payload: parseJson(r.payload) });
  }
  let energy = null;
  if (scope === 'full') energy = db.prepare(`SELECT ${ENERGY_COLS} FROM energy WHERE deleted=0 ORDER BY path`).all();
  return { data, energy };
}

// The analysis rows -> analysis/energy.jsonl + analysis/energy.bin
function packEnergy(rows) {
  const lines = [], parts = [];
  let off = 0;
  for (const r of rows) {
    let blob = null;
    if (r.blob && r.blob.length) { const b = Buffer.from(r.blob); parts.push(b); blob = [off, b.length]; off += b.length; }
    lines.push({
      path: r.path, ts: r.ts, intensity: r.intensity, bpm: r.bpm, bpmSource: r.bpm_source,
      melodicScore: r.melodic_score, melodicHarmonicity: r.melodic_harmonicity, melodicMovement: r.melodic_movement,
      subHz: r.sub_hz, subQuality: r.sub_quality, explosivenessMetrics: parseJson(r.explosiveness_metrics),
      durationSec: r.duration_sec ?? null, skipReason: r.skip_reason ?? null, blob
    });
  }
  return { jsonl: jsonl(lines), bin: Buffer.concat(parts), count: lines.length, blobs: parts.length };
}

// Writes an archive of the server's database to `file`. -> manifest
async function writeServerArchive(db, file, { scope, reason, epoch, maxSeq, serverVersion }) {
  const snap = snapshot(db, scope);
  const created = new Date();
  const manifest = {
    format: FORMAT, version: VERSION, created: created.toISOString(), createdMs: created.getTime(),
    scope, reason, source: { type: 'server', version: serverVersion, epoch, maxSeq },
    counts: { data: Object.fromEntries(Object.entries(snap.data).map(([k, v]) => [k, v.length])) },
    contents: scope === 'full' ? ['data', 'analysis'] : ['data']
  };
  let energy = null;
  if (snap.energy) {
    energy = packEnergy(snap.energy);
    manifest.counts.analysis = energy.count; manifest.counts.analysedWaveforms = energy.blobs;
  }
  const z = await createZip(file);
  try {
    await z.add('manifest.json', JSON.stringify(manifest, null, 2));
    await z.add('README.txt', README(manifest));
    for (const [k, rows] of Object.entries(snap.data)) await z.add(`data/${k}.jsonl`, jsonl(rows));
    if (energy) {
      await z.add('analysis/energy.jsonl', energy.jsonl);
      await z.add('analysis/energy.bin', energy.bin);
    }
    manifest.bytes = await z.finish();
  } catch (e) { await z.abort(); throw e; }
  return manifest;
}

// Opens an archive (a Buffer). Also takes the older formats: the server's hourly core-*.json backups
// ({rows:[{kind,key,ts,removed,payload}]}). -> { manifest, data: {kind: rows}, energy: rows|null, blobOf(row) }
function openArchive(buf, nameHint = '') {
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (!isZip) {
    const j = parseJson(buf.toString('utf8'));
    if (j && Array.isArray(j.rows)) {   // core-<time>.json (server backups before archives)
      const data = {};
      for (const r of j.rows) { if (!r || !r.kind) continue; (data[r.kind] = data[r.kind] || []).push({ key: r.key, ts: r.ts, removed: !!r.removed, payload: r.payload }); }
      const created = j.exported || null;
      return { manifest: { format: 'core-json', scope: 'data', created, createdMs: created ? Date.parse(created) : 0, source: { type: 'server' } }, data, energy: null, blobOf: () => null };
    }
    throw new Error(`${nameHint || 'this file'} isn't an Uzikext archive`);
  }
  const z = readZip(buf);
  const manifest = z.json('manifest.json');
  if (!manifest || manifest.format !== FORMAT) {
    if (z.has('manifest.json') && parseJson(z.text('manifest.json'))?.format === 'uzikext-everything')
      throw new Error('this is an older "Export everything" file: import it on a device (⋮ → Import everything…), then that device syncs it to the server');
    throw new Error(`${nameHint || 'this file'} isn't an Uzikext archive`);
  }
  if (manifest.version > VERSION) throw new Error(`this archive was made by a newer version (format ${manifest.version}); update the sync server first`);
  const data = {};
  for (const n of z.names) {
    const m = /^data\/([a-z]+)\.jsonl$/.exec(n);
    if (m) data[m[1]] = parseJsonl(z.text(n));
  }
  let energy = null, bin = null;
  if (z.has('analysis/energy.jsonl')) { energy = parseJsonl(z.text('analysis/energy.jsonl')); bin = z.get('analysis/energy.bin') || Buffer.alloc(0); }
  const blobOf = r => (r.blob && bin) ? bin.subarray(r.blob[0], r.blob[0] + r.blob[1]) : null;
  return { manifest, data, energy, blobOf };
}

// A record's content without its timestamp (what changed, regardless of when)
function sameContent(a, b) {
  const strip = v => { if (!v || typeof v !== 'object') return v; const { ts, _ts, _sts, ...rest } = v; return rest; };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

// A record as removed, the way the devices read a removal (CORE_REMOVED in player.js); undefined: can't be
// removed (a setting)
function removalOf(kind, p) {
  p = p || {};
  switch (kind) {
    case 'tags': case 'bans': case 'notes': return { ...p, removed: true };
    case 'played': return { ...p, played: false, count: 0 };
    case 'excluded': return { ...p, excluded: false };
    case 'vibes': return { ...p, on: false };
    case 'meta': return null;
    default: return undefined;
  }
}

// How an archive is restored, from where it comes from:
//   'rollback'  a backup of this database: everything in it comes back as it was then (written with the time
//               of the restore, so it wins on every device); what was added since stays; plays keep the
//               higher count; a note deleted since comes back (as a new note: a deletion is final on the
//               devices); a track analysed again since keeps its newer analysis.
//   'exact'     a "before a restore" backup of this database, undoing that restore: what the restore wrote, and
//               hasn't changed since, goes back exactly as it was (what it brought back is removed again);
//               nothing else is touched. (Without the record of what that restore wrote: 'rollback'.)
//   'merge'     anything else: a backup of another database (a new one after a lost disk), a device's
//               export: merged by date, the newer of each record wins; nothing newer is overwritten.
// Records keep their own dates (a star's date stays the day it was starred): a restore only changes when the
// server's copy of a record was written, which is what the devices compare.
function restoreMode(manifest, epoch, undo) {
  const src = manifest.source || {};
  if (src.type !== 'server' || (src.epoch && epoch && src.epoch !== epoch)) return 'merge';
  return manifest.reason === 'before-restore' && undo ? 'exact' : 'rollback';
}

// -> counts { mode, data, notesBack, analysis, removed, unchanged, keptNewer }
// undo: { from, to }, the seq range the restore being undone wrote (exact mode)
function restoreArchive(db, arc, { nextSeq, stmts, epoch, undo }) {
  const mode = restoreMode(arc.manifest, epoch, undo);
  const now = Date.now();
  const createdMs = Number(arc.manifest.createdMs) || 0;
  const coreGet = db.prepare('SELECT ts, removed, payload FROM core WHERE kind=? AND key=?');
  const write = (kind, key, ts, removed, payload) => stmts.coreUpsert.run(kind, key, ts, removed ? 1 : 0, JSON.stringify(payload ?? null), nextSeq());
  const out = { mode, data: 0, notesBack: 0, analysis: 0, removed: 0, unchanged: 0, keptNewer: 0 };
  let bump = 0;
  // the notes there are now, by track and text (a deleted note comes back only if it isn't there already)
  const noteId = p => (p && p.path) + '\u0000' + (p && (p.note ?? p.text) || '');
  let liveNotes = null;
  const noteThere = p => {
    if (!liveNotes) {
      liveNotes = new Set();
      for (const n of db.prepare("SELECT payload FROM core WHERE kind='notes' AND removed=0").all()) {
        const v = parseJson(n.payload);
        if (v && !v.removed) liveNotes.add(noteId(v));
      }
    }
    return liveNotes.has(noteId(p));
  };
  const noteBack = p => {   // a deleted note, back as a new note (same track, same text, its own new date)
    const ts = now + (bump++);
    const q = { ...(p || {}), ts };
    delete q.removed;
    write('notes', `${ts}|${q.path}`, ts, false, q);
    if (liveNotes) liveNotes.add(noteId(q));
    out.notesBack++;
  };
  db.exec('BEGIN');
  try {
    if (mode === 'exact') { undoRestore(db, arc, undo, { write, now, out, stmts, nextSeq }); db.exec('COMMIT'); return out; }
    for (const kind of CORE_KINDS) {
      const rows = arc.data[kind] || [];
      for (const r of rows) {
        if (!r || typeof r.key !== 'string') continue;
        const cur = coreGet.get(kind, r.key);
        const curPayload = cur ? parseJson(cur.payload) : null;
        if (mode === 'merge') {   // the newer one wins, each keeps its own date
          if (cur && !((r.ts || 0) > cur.ts)) { out.unchanged++; continue; }
          if (kind === 'notes' && cur) { out.unchanged++; continue; }   // (a note is never re-written)
          write(kind, r.key, r.ts || 0, r.removed, r.payload);
          if (!r.removed) out.data++;
          continue;
        }
        // rollback / exact
        if (kind === 'notes') {
          if (r.removed) { out.unchanged++; continue; }
          if (cur && !cur.removed) { out.unchanged++; continue; }
          if (!noteThere(r.payload)) noteBack(r.payload); else out.unchanged++;
          continue;
        }
        if (r.removed) {
          if (!cur) { write(kind, r.key, r.ts || 0, true, r.payload); continue; }   // (a tombstone keeps its own date)
          if (cur.removed) { out.unchanged++; continue; }
          out.keptNewer++;   // added again since: it stays
          continue;
        }
        let want = r.payload;
        if (mode === 'rollback' && kind === 'played' && want && curPayload && !cur.removed && curPayload.played !== false && want.played !== false) {
          want = { ...want, count: Math.max(Number(want.count ?? 1), Number(curPayload.count ?? 1)) };
        }
        if (cur && !cur.removed && sameContent(curPayload, want)) { out.unchanged++; continue; }
        write(kind, r.key, now, false, want);
        out.data++;
      }
    }
    if (arc.energy) {
      const eGet = db.prepare('SELECT ts, deleted, blob FROM energy WHERE path=?');
      for (const r of arc.energy) {
        if (!r || typeof r.path !== 'string') continue;
        const blob = arc.blobOf(r);
        const cur = eGet.get(r.path);
        if (!blob) {   // a "skipped (too long)" marker only
          if (!cur && r.skipReason) stmts.energyMarkSkipped.run(r.path, r.ts || now, r.durationSec ?? null, r.skipReason, nextSeq());
          continue;
        }
        const live = cur && !cur.deleted && cur.blob;
        if (live && Buffer.compare(Buffer.from(cur.blob), blob) === 0) { out.unchanged++; continue; }
        if (live && mode === 'rollback' && cur.ts > createdMs) { out.keptNewer++; continue; }   // analysed again since
        if (live && mode === 'merge' && !((r.ts || 0) > cur.ts)) { out.keptNewer++; continue; }
        if (cur && cur.deleted && mode === 'merge' && !((r.ts || 0) > cur.ts)) { out.unchanged++; continue; }
        stmts.energyUpsert.run(r.path, mode === 'merge' ? (r.ts || 0) : now, r.intensity ?? null, r.bpm ?? null, r.bpmSource ?? null,
          r.melodicScore ?? null, r.melodicHarmonicity ?? null, r.melodicMovement ?? null, r.subHz ?? null, r.subQuality ?? null,
          r.explosivenessMetrics ? JSON.stringify(r.explosivenessMetrics) : null, blob, 0, nextSeq());
        out.analysis++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out;
}

// Undoing a restore (exact mode): each record that restore wrote (its seq in undo.from..undo.to: not changed
// since) goes back to how it was in the "before a restore" archive; one that wasn't there then (brought back
// by the restore, a note brought back as a new one) is removed again. Settings can't be removed: they stay.
// Analysis: a track whose analysis the restore replaced gets the earlier one back; one it brought back stays.
function undoRestore(db, arc, undo, { write, now, out, stmts, nextSeq }) {
  const then = new Map();
  for (const kind of CORE_KINDS) for (const r of arc.data[kind] || []) if (r && typeof r.key === 'string') then.set(kind + '\u0000' + r.key, r);
  const rows = db.prepare('SELECT kind, key, removed, payload FROM core WHERE seq BETWEEN ? AND ?').all(undo.from, undo.to);
  for (const c of rows) {
    const was = then.get(c.kind + '\u0000' + c.key), cur = parseJson(c.payload);
    if (was && !was.removed) {
      if (!c.removed && sameContent(cur, was.payload)) { out.unchanged++; continue; }
      write(c.kind, c.key, now, false, was.payload); out.data++;
      continue;
    }
    if (c.removed) { out.unchanged++; continue; }
    const rem = was ? (was.payload ?? removalOf(c.kind, cur)) : removalOf(c.kind, cur);
    if (rem === undefined) { out.keptNewer++; continue; }
    write(c.kind, c.key, now, true, rem); out.removed++;
  }
  if (!arc.energy) return;
  const byPath = new Map(arc.energy.map(r => [r.path, r]));
  for (const c of db.prepare('SELECT path, blob FROM energy WHERE deleted=0 AND seq BETWEEN ? AND ?').all(undo.from, undo.to)) {
    const r = byPath.get(c.path), blob = r && arc.blobOf(r);
    if (!blob || (c.blob && Buffer.compare(Buffer.from(c.blob), blob) === 0)) continue;
    stmts.energyUpsert.run(r.path, now, r.intensity ?? null, r.bpm ?? null, r.bpmSource ?? null,
      r.melodicScore ?? null, r.melodicHarmonicity ?? null, r.melodicMovement ?? null, r.subHz ?? null, r.subQuality ?? null,
      r.explosivenessMetrics ? JSON.stringify(r.explosivenessMetrics) : null, blob, 0, nextSeq());
    out.analysis++;
  }
}

module.exports = { FORMAT, VERSION, CORE_KINDS, writeServerArchive, openArchive, restoreArchive, restoreMode, snapshot, packEnergy, parseJsonl };
