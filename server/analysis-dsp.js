// Thin wrapper around energy-analysis-core.js — see that file's header for the full explanation. This
// file contains NO analysis logic of its own; it just adapts the shared core's functions into the single
// analyzeTrack() call analysis-scheduler.js expects, mirroring exactly what energy-worker.js's onmessage
// handler does client-side — including the same needFull/needExplosiveness split, so a server-side
// backfill (analysis-scheduler.js calling this for a track that already has everything except
// Explosiveness) can skip the expensive intensity/melody/BPM/sub-bass passes the same way the client
// does. If this file and energy-worker.js's entry point ever look like they're doing different things,
// something has gone wrong — they should always be trivial, near-identical wrappers around the same
// shared computation.
const { computeEnergyProfile, computeSubBass, computeExplosivenessMetrics } = require('./energy-analysis-core.js');

function analyzeTrack(samples, samplesR, sampleRate, trebleCutoffHz, melodyLoHz, melodyHiHz, {
  needFull = true, needExplosiveness = true, existingBpm, onProgress,
} = {}) {
  let result = {};
  if (needFull) {
    const r = computeEnergyProfile(samples, sampleRate, trebleCutoffHz, melodyLoHz, melodyHiHz);
    let sub = { subHz: null, subQuality: null };
    try { sub = computeSubBass(samples, samplesR || null, sampleRate); } catch (e2) { /* leave sub as nulls */ }
    result = { ...r, ...sub };
  }
  if (needExplosiveness) {
    // Only the 9 raw metrics — no composite 0-100 score. That's computed client-side, ranked against
    // whatever's currently visible in uzikext, never here and never stored/synced.
    try {
      const bpmForExplo = needFull ? result.bpm : existingBpm;
      result.explosivenessMetrics = computeExplosivenessMetrics(samples, sampleRate, bpmForExplo, onProgress);
    } catch (e3) { result.explosivenessMetrics = null; }
  }
  return result;
}

module.exports = { analyzeTrack, computeEnergyProfile, computeSubBass, computeExplosivenessMetrics };
