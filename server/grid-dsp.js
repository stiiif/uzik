// The grid analysis on the server: the tempo, the beat grid and the 1 of a decoded track, with the verdict, the
// same as Uzikext works out on a computer. Two files shared with Uzikext, as energy-analysis-core.js is, kept as
// straight copies (the same files as Uzikext's ui/ folder; copy them over when they change there):
//   waveview.js            the waveform data the grid is read from: the peaks (150 a second) and the hits
//                          (1000 a second). Only its computePeaks and computeHits run here; the rest of it
//                          draws the waveforms on a page and is never called.
//   grid-analysis-core.js  the grid analysis itself (its header explains the method).
// Run on the analysis worker thread (analysis-worker.js), never on the server's main thread.
'use strict';
// (waveview.js puts itself on the page's `window`, or a worker's `self`: here, this thread's own global)
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
require('./waveview.js');
const GridCore = require('./grid-analysis-core.js');
const WaveView = globalThis.self.WaveView;

const MAX_SEC = 3 * 3600;   // (as Uzikext: longer than 3 hours, a set rather than a track: no grid)
const TOO_LONG = { bpm: null, ok: false, why: [{ code: 'long' }], notes: [] };

// -> the grid analysis's result (see analyzeGrid in grid-analysis-core.js), or null (too short)
// left, right: Float32Array (right may be null). The two are mixed into `left` for the bass's notes, after
// the peaks and the hits: the caller doesn't use them after this.
async function analyzeGridOf(left, right, sampleRate) {
  if (!left) return null;
  if (left.length / sampleRate > MAX_SEC) return TOO_LONG;
  const chs = right ? [left, right] : [left];
  const peaks = await WaveView.computePeaks(chs, sampleRate);
  const hits = await WaveView.computeHits(chs, sampleRate);
  if (right) for (let i = 0; i < left.length; i++) left[i] = (left[i] + right[i]) / 2;
  return GridCore.analyzeGrid(peaks, hits, { bass: GridCore.bassBand(left, sampleRate) });
}

// The record kept for a track (core kind 'grids', synced to the devices; the same shape Uzikext writes):
// { path, a: the method's number, bpm, t: a 1 (s; the grid is this anchor and the BPM), ok: 1 nothing to check
// / 0 to check, why: [the reasons, as codes], notes: [unusual but fine], ts: when, by: 'server' }
function gridRecord(path, g, ts) {
  return { path, a: GridCore.GRID_V, bpm: g && g.bpm ? g.bpm : null, t: g && g.bpm ? Math.round(g.bar0 * 1e5) / 1e5 : 0,
    ok: g && g.ok ? 1 : 0, why: (g && g.why) || [{ code: 'none' }], notes: (g && g.notes) || [], ts, by: 'server' };
}

module.exports = { analyzeGridOf, gridRecord, TOO_LONG, GRID_V: GridCore.GRID_V };
