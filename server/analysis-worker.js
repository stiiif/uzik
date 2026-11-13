// Runs analyzeTrack() on a worker_threads Worker, off the server's main thread — the server-side
// counterpart to why energy-worker.js (the extension's Web Worker) exists at all: analysis-dsp.js's
// computation is pure, synchronous JavaScript with no yield points inside it, and for a long track (a DJ
// mix, an extended set), that single block can run for tens of seconds. Running it directly on the main
// thread — the SAME thread the HTTP server listens on — freezes /health and every other request for that
// whole duration. This file exists specifically so it doesn't.
const { parentPort } = require('worker_threads');
const { analyzeTrack } = require('./analysis-dsp.js');
const { analyzeGridOf } = require('./grid-dsp.js');

// Two message shapes, distinguished by `type` — { type: 'progress', pct } fires zero or more times
// mid-analysis (see computeExplosivenessMetrics's own weighted-stage reporting in energy-analysis-core.js
// for why the pct values aren't evenly spaced), then exactly one { type: 'done', ok, ... } fires when
// analysis actually finishes. The caller (analysis-scheduler.js's run()) tells these apart to know when
// to keep waiting vs. resolve/reject.
// needGrid: the grid analysis too (grid-dsp.js), after the rest, from the same decoded sound: { ..., grid }
// (null: no steady beat found, or too long). needFull and needExplosiveness both false: the grid alone.
parentPort.on('message', async (msg) => {
  try {
    const { samples, samplesR, sampleRate, trebleCutoffHz, melodyLoHz, melodyHiHz, needFull, needExplosiveness, existingBpm, needGrid } = msg;
    const onProgress = (pct) => parentPort.postMessage({ type: 'progress', pct });
    const left = new Float32Array(samples), right = samplesR ? new Float32Array(samplesR) : null;
    const result = needFull || needExplosiveness
      ? analyzeTrack(left, right, sampleRate, trebleCutoffHz, melodyLoHz, melodyHiHz, { needFull, needExplosiveness, existingBpm, onProgress })
      : {};
    if (needGrid) {
      parentPort.postMessage({ type: 'progress', pct: 0.95 });   // (a sign of life before the grid's few seconds)
      try { result.grid = await analyzeGridOf(left, right, sampleRate); } catch (e) { result.grid = null; result.gridError = String((e && e.message) || e); }
    }
    parentPort.postMessage({ type: 'done', ok: true, result });
  } catch (err) {
    parentPort.postMessage({ type: 'done', ok: false, error: String((err && err.message) || err) });
  }
});
