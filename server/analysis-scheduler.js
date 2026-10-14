// Background queue that works through un-analyzed tracks in the mounted music library, continuously,
// without needing any client to play or manually request analysis. This is what "the server does it,
// since it actually runs 24/7" turned into — see the design discussion this came out of: analysis needs
// (a) the raw audio (this reads it directly off MUSIC_DIR, no client involved) and (b) the same DSP
// analysis-dsp.js already runs client-side, kept as a verified straight copy rather than a reimplementation.
//
// Disabled unless MUSIC_DIR is set — a server with no configured library mount does nothing here, same as
// today, no behavior change for anyone who doesn't opt in.

const { scanMusicDir } = require('./library-scan.js');
const { decodeAudioFile } = require('./audio-decode.js');
const Codec = require('./energy-codec.js');
const { Worker } = require('worker_threads');
const path = require('path');

const DEFAULT_ANALYSIS_SETTINGS = { trebleCutoffHz: 10000, melodyBandLoHz: 200, melodyBandHiHz: 2000 }; // mirrors DEFAULT_ANALYSIS in player.js

function readAnalysisSettings(db) {
  const out = { ...DEFAULT_ANALYSIS_SETTINGS };
  const stmt = db.prepare("SELECT payload FROM core WHERE kind='settings' AND key=?");
  for (const key of Object.keys(DEFAULT_ANALYSIS_SETTINGS)) {
    try {
      const row = stmt.get(key);
      if (!row) continue;
      const parsed = JSON.parse(row.payload);
      const v = Number(parsed && parsed.value);
      if (Number.isFinite(v)) out[key] = v;
    } catch (e) { /* malformed row — keep default */ }
  }
  return out;
}

// The on/off toggle itself rides the exact same synced-settings mechanism as trebleCutoffHz/etc. (see
// setSyncedSetting in player.js) — one shared `core`/`settings` row the extension writes and the server
// reads back on its own next tick, no new endpoint needed. Defaults to OFF (an explicit opt-in gate) when
// nothing's been set yet: MUSIC_DIR/MUSIC_ROOT_NAME alone configure the *capability*, they don't start it
// running — someone has to actually flip the switch in the extension's Sync panel first.
function readAnalysisEnabled(db) {
  try {
    const row = db.prepare("SELECT payload FROM core WHERE kind='settings' AND key='analysisEnabled'").get();
    if (!row) return false;
    const parsed = JSON.parse(row.payload);
    return parsed && parsed.value === true;
  } catch (e) { return false; }
}

// analyzeTrack() (in analysis-dsp.js) is pure, synchronous JavaScript math with no yield points inside
// it — running it directly on this process's main thread would freeze the HTTP server (including
// /health) for however long a track takes to analyze, which for a long track (a DJ mix, an extended set)
// can be tens of seconds. A single, persistent worker_threads Worker — created once, reused for every
// track, mirroring exactly how the extension's own energy-worker.js is a single reused Web Worker rather
// than one per track — keeps that computation off the main thread entirely, the same way the browser
// side already protects its UI thread from this exact cost.
function makeAnalysisWorkerRunner(log) {
  let worker = null;
  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, 'analysis-worker.js'));
    // A crash here (e.g. an out-of-memory on a pathological file) shouldn't take the scheduler down with
    // it — null out the reference so the next call recreates a fresh worker, and let the in-flight run()
    // call's own listeners (below) turn this into a normal "this track failed" outcome instead.
    worker.on('error', (err) => { log(`Analysis worker crashed: ${err.message} — restarting it for the next track`); worker = null; });
    worker.on('exit', (code) => { if (code !== 0) log(`Analysis worker exited unexpectedly (code ${code}) — restarting it for the next track`); worker = null; });
    return worker;
  }
  // 20 minutes: generous enough that even a legitimately very long track (a 30-40 minute extended mix,
  // under concurrency-driven CPU contention) should still finish well inside it — the point isn't to catch
  // "slow", it's to eventually recover from "actually stuck" (a pathological input hanging the DSP code
  // itself, which — unlike decodeAudioFile's ffmpeg call — had no timeout at all before this: a genuine
  // hang here would leave that lane busy forever, with no failure logged and no way to tell it apart from
  // just being slow).
  function run(samples, samplesR, sampleRate, settings, needFull, existingBpm, { timeoutMs = 20 * 60 * 1000, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const w = ensureWorker();
      let settled = false;
      let timer;
      // An INACTIVITY timeout, not a fixed ceiling on total time — reset on every progress update (see
      // below), not just once at the start. A fixed ceiling would risk killing a legitimately very long
      // track that's genuinely still working (this pipeline can now report real progress mid-analysis —
      // see computeExplosivenessMetrics's weighted-stage reporting — so "no update in N minutes" is a much
      // more honest definition of "stuck" than "took longer than N minutes total").
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          w.terminate(); // may genuinely be stuck (e.g. an infinite loop) — terminate rather than trust it to exit on its own
          worker = null; // force ensureWorker() to create a fresh one for the next call
          reject(new Error(`analysis worker timed out after ${timeoutMs}ms with no progress`));
        }, timeoutMs);
      };
      armTimer();
      const onMessage = (msg) => {
        if (settled) return;
        if (msg.type === 'progress') { armTimer(); if (onProgress) onProgress(msg.pct); return; }
        settled = true; clearTimeout(timer); cleanup();
        msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
      };
      const onError = (err) => { if (settled) return; settled = true; clearTimeout(timer); worker = null; cleanup(); reject(err); };
      function cleanup() { w.off('message', onMessage); w.off('error', onError); }
      w.on('message', onMessage);
      w.on('error', onError);
      const transferList = samplesR ? [samples.buffer, samplesR.buffer] : [samples.buffer];
      w.postMessage({
        samples: samples.buffer, samplesR: samplesR ? samplesR.buffer : null, sampleRate,
        trebleCutoffHz: settings.trebleCutoffHz, melodyLoHz: settings.melodyBandLoHz, melodyHiHz: settings.melodyBandHiHz,
        needFull, needExplosiveness: true, existingBpm,
      }, transferList);
    });
  }
  return { run, terminate: () => { if (worker) { worker.terminate(); worker = null; } } };
}

function startAnalysisScheduler({ db, energyUpsertStmt, energyGetStmt, energyMarkSkippedStmt, nextSeq, musicDir, rootName, roots, heldBy, paceMs, rescanMs, concurrency = 1, maxDurationSec = 0, log, broadcast }) {
  // One persistent worker per lane, each able to have one track in flight at a time — concurrency > 1
  // means that many tracks genuinely analyze simultaneously, not just queued back-to-back. Safe to do
  // now specifically because each lane's DSP work runs on its OWN worker thread (see
  // makeAnalysisWorkerRunner above) — the reason this was deliberately kept sequential originally (before
  // that existed) was to protect server responsiveness from analysis blocking the main thread; now that
  // it can't, the only remaining tradeoff is NAS CPU/disk load, which is why this defaults to 1 and is an
  // explicit opt-in via ANALYSIS_CONCURRENCY, not a silent behavior change.
  const laneCount = Math.max(1, concurrency);
  const workerRunners = Array.from({ length: laneCount }, () => makeAnalysisWorkerRunner(log));
  const laneBusy = new Array(laneCount).fill(false);
  // Selects explosiveness_metrics/bpm too, not just path — field-aware, not a bare existence check. A
  // path already in the table but missing Explosiveness specifically (e.g. analyzed before that metric
  // existed) still needs a pass, just a cheap backfill-only one rather than full re-analysis — mirrors
  // exactly what analyzeEnergy() does client-side, for the same reason: the goal from the start was "add
  // this one new metric without re-analyzing everything that's already correct".
  const stmtExistingPaths = db.prepare('SELECT path, explosiveness_metrics, bpm, skip_reason FROM energy WHERE deleted=0');
  // currentPaths[i] is the path lane i is analyzing right now, or null if that lane is idle — one slot
  // per lane, indexed the same way workerRunners/laneBusy are, so /health can show exactly what's in
  // flight at concurrency > 1, not just an aggregate count.
  // currentProgress[i] is lane i's fraction (0-1) through its current track's analysis, or null when
  // idle — parallels currentPaths exactly, one slot per lane, so /health can report per-track progress
  // rather than only the library-wide "N of totalKnown" figure.
  const stats = { totalKnown: 0, queueLength: 0, analyzed: 0, failed: 0, skipped: 0, lastScanAt: 0, lastError: null, running: false, enabled: false, activeLanes: 0, laneCount, currentPaths: new Array(laneCount).fill(null), currentProgress: new Array(laneCount).fill(null) };
  let queue = [];
  let rescanTimer = null, workTimer = null, stopped = false;
  // the music folders and the names the devices know them by (music-match.js), or the one of the old settings
  const rootList = Array.isArray(roots) && roots.length ? roots : [{ dir: musicDir, name: rootName }];
  stats.roots = rootList.map(r => ({ name: r.name, dir: r.dir }));

  async function rescan() {
    let found;
    try { found = []; for (const r of rootList) found.push(...await scanMusicDir(r.dir, r.name)); }
    catch (e) { log(`Library scan failed: ${e.message}`); return; }
    if (stopped) return;
    const existingRows = new Map(stmtExistingPaths.all().map(r => [r.path, r]));
    queue = [];
    let alreadySkipped = 0;
    for (const f of found) {
      const row = existingRows.get(f.path);
      if (row && row.skip_reason) { alreadySkipped++; continue; } // a permanent decision from a previous scan — don't re-decode just to re-check
      if (!row) queue.push({ ...f, needFull: true, existingBpm: undefined }); // genuinely new
      else if (row.explosiveness_metrics == null) queue.push({ ...f, needFull: false, existingBpm: row.bpm }); // backfill only
      // else: already fully analyzed, nothing to do
    }
    stats.totalKnown = found.length;
    stats.queueLength = queue.length;
    // Unlike stats.analyzed/failed (pure session-scoped event counters, never reset), skipped is closer in
    // spirit to totalKnown/queueLength: "how many currently exist in this state", answerable fresh from
    // the database each rescan — a track skipped in a PREVIOUS server session should still count here, not
    // reset to 0 just because the process restarted. Set fresh here from the database's actual total, then
    // incremented live by processLane() for any new skip discovered between rescans, so the number stays
    // accurate and immediately responsive rather than only updating once per rescan cycle.
    stats.skipped = alreadySkipped;
    stats.lastScanAt = Date.now();
    stats.samplePaths = found.slice(0, 3).map(f => f.path);
    const backfillCount = queue.filter(q => !q.needFull).length;
    log(`Library scan: ${found.length} tracks found under ${rootList.map(r => `"${r.name}"`).join(", ")}, ${queue.length} need analysis (${queue.length - backfillCount} new, ${backfillCount} backfill-only), ${alreadySkipped} previously skipped as too long`);
    if (found.length) log(`Sample path this scan generated: "${found[0].path}" — compare this EXACTLY (case, punctuation, everything) against the File Path column for the same track in the extension. A mismatch anywhere means results are being written under a path the client will never match.`);
  }

  async function processLane(laneIdx) {
    if (stopped || laneBusy[laneIdx] || !stats.enabled || !queue.length) return;
    laneBusy[laneIdx] = true;
    stats.activeLanes = laneBusy.filter(Boolean).length;
    stats.running = stats.activeLanes > 0;
    const item = queue.shift();
    stats.queueLength = queue.length;
    stats.currentPaths[laneIdx] = item.path;
    stats.currentProgress[laneIdx] = 0;
    try {
      const settings = readAnalysisSettings(db); // re-read each track so a live settings change takes effect without a restart
      const { left, right, sampleRate } = await decodeAudioFile(item.absPath);
      const durationSec = left.length / sampleRate;
      if (maxDurationSec > 0 && durationSec > maxDurationSec) {
        // Skip the expensive part (the DSP analysis, not the decode — duration isn't knowable without at
        // least decoding, and decode itself is comparatively cheap) and record this as a PERMANENT
        // decision, not silence: without energyMarkSkippedStmt, this track would look identical to
        // "genuinely still needs analysis" forever (no explosiveness_metrics, since it was never
        // analyzed), and every future rescan would re-discover and re-decode it just to make the same
        // duration check again, indefinitely.
        energyMarkSkippedStmt.run(item.path, Date.now(), durationSec, 'too_long', nextSeq());
        stats.skipped++;
        log(`Skipping (${Math.round(durationSec / 60)} min, over the ${Math.round(maxDurationSec / 60)} min limit): ${item.path}`);
        return;
      }
      if (stopped) return;
      const result = await workerRunners[laneIdx].run(left, right, sampleRate, settings, item.needFull, item.existingBpm,
        { onProgress: (pct) => { stats.currentProgress[laneIdx] = pct; } });
      if (stopped) return;   // (settings changed while this one ran: a new scheduler takes over)
      const ts = Date.now();

      const explosivenessMetricsJson = result.explosivenessMetrics ? JSON.stringify(result.explosivenessMetrics) : null;
      if (item.needFull) {
        const blob = Buffer.from(Codec.encode(result));
        energyUpsertStmt.run(item.path, ts, result.intensity, result.bpm, result.bpmSource,
          result.melodicScore, result.melodicHarmonicity, result.melodicMovement,
          result.subHz, result.subQuality, explosivenessMetricsJson, blob, 0, nextSeq());
      } else {
        // Backfill-only: `result` here is JUST { explosivenessMetrics } — analyzeTrack was told
        // needFull:false and never computed intensity/bpm/melody/sub-bass at all. Read the EXISTING row
        // and merge the new field in, both into the blob (decode -> splice -> re-encode) and the explicit
        // column, rather than overwriting everything else with nulls — mirrors storeEnergy()'s merge
        // pattern client-side exactly.
        const existing = energyGetStmt.get(item.path);
        if (!existing || !existing.blob) throw new Error('existing row disappeared before backfill could complete');
        const decoded = Codec.decode(existing.blob);
        const mergedBlob = Buffer.from(Codec.encode({ ...decoded, explosivenessMetrics: result.explosivenessMetrics }));
        energyUpsertStmt.run(item.path, ts, existing.intensity, existing.bpm, existing.bpm_source,
          existing.melodic_score, existing.melodic_harmonicity, existing.melodic_movement,
          existing.sub_hz, existing.sub_quality, explosivenessMetricsJson, mergedBlob, 0, nextSeq());
      }
      // A normal client push goes through afterWrite() in server.js, which both responds to the HTTP
      // request AND calls broadcast('energy') to nudge every connected client's SSE listener. This write
      // has no HTTP request to respond to, but still needs that same nudge — without it, this result sits
      // correctly in the database but no open extension finds out about it until its own periodic energy
      // sync timer happens to run (up to several minutes later), not the near-real-time push every other
      // energy write already gets.
      if (broadcast) broadcast('energy');
      stats.analyzed++;
    } catch (e) {
      if (stopped) return;
      // Skip and continue — a NAS hiccup or a single unreadable/corrupt file shouldn't stall the rest of
      // the backlog. Not re-queued automatically; the next rescan (which re-diffs against what's actually
      // in the energy table) will pick it back up naturally if it's still missing.
      stats.failed++;
      stats.lastError = `${item.path}: ${e.message}`;
      log(`Analysis failed, skipping: ${item.path}: ${e.message}`);
    } finally {
      laneBusy[laneIdx] = false;
      stats.currentPaths[laneIdx] = null;
      stats.currentProgress[laneIdx] = null;
      stats.activeLanes = laneBusy.filter(Boolean).length;
      stats.running = stats.activeLanes > 0;
    }
  }

  // Fires every tick (paceMs) and dispatches to every currently-free lane, not just one — each call is
  // fire-and-forget (not awaited) specifically so multiple lanes can be in flight at once; processLane's
  // own laneBusy check is what prevents a lane from being double-dispatched into.
  function processNext() {
    stats.enabled = readAnalysisEnabled(db); // read fresh each tick — an extension toggle takes effect
                                              // within one pace cycle, no server restart needed
    // held (the server inside the Uzikext app: the decks are playing, on battery, the computer in use…):
    // nothing new starts; what's running finishes
    stats.held = heldBy ? heldBy() : [];
    if (!stats.enabled || stats.held.length) return;
    for (let i = 0; i < laneCount; i++) processLane(i);
  }

  stats.enabled = readAnalysisEnabled(db); // initialize before the first tick, so /health is accurate immediately
  rescan(); // deliberately NOT awaited — rescan() is async now specifically so this doesn't block
            // server.listen() (called shortly after this function returns, in server.js) from starting
            // right away. The server is reachable immediately; the first scan's results just aren't in
            // stats yet until it finishes in the background, same as any periodic rescan after it.
  rescanTimer = setInterval(rescan, rescanMs);
  workTimer = setInterval(processNext, paceMs);

  return {
    getStats: () => ({ ...stats, held: heldBy ? heldBy() : [] }),
    stop: () => { stopped = true; clearInterval(rescanTimer); clearInterval(workTimer); workerRunners.forEach(r => r.terminate()); },
  };
}

module.exports = { startAnalysisScheduler, readAnalysisSettings, readAnalysisEnabled, DEFAULT_ANALYSIS_SETTINGS };
