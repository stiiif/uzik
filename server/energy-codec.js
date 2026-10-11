// Energy blob codec — identical copy lives in the sync server. One compact binary record per track:
//   'E' 'N' | u8 version | u8 flags | u16 nIntensity | u16 nBass | u16 nKick | u32 nKickTimes
//   | nIntensity bytes | nBass bytes | nKick bytes | nKickTimes float32 (little-endian)
//   v2 appends: u16 bpm*100 (0 = unknown) | u8 bpm confidence 0-100
//   v3 appends: u8 bpm source (0=unknown, 1=kick pattern, 2=beat-density analysis, 3=both agree)
//   v4 appends: u16 nTreble | nTreble bytes (per-bucket high-frequency presence, mirrors bassPresence)
//   v5 appends: u8 melodicScore | u8 melodicHarmonicity | u8 melodicMovement (0-100 each, 255 = unknown —
//     a rough proxy for "how melodic", not pitch detection; see energy-worker.js for what it actually measures)
//   v6 appends: u16 subHz (0 = unknown — how low the sub-bass usefully extends, in Hz) | u8 subQuality
//     (0-100, 255 = unknown — mono-compatibility below ~90Hz + clean rolloff below ~20Hz; see
//     computeSubBass in energy-worker.js)
//   v7 appends: u8 explosiveness (0-100, 255 = unknown). DEAD FIELD as of v8 — always writes 255 now, never
//     read. This used to hold a composite 0-100 "Explosiveness" score, computed at analysis time from
//     fixed, guessed bounds. That approach turned out to be badly miscalibrated (see v8's comment below)
//     and was replaced, not fixed — the composite is now computed CLIENT-SIDE, ranked against whatever
//     tracks are currently visible, and is never stored at all. This byte is kept, unused, purely so v7
//     blobs still decode without special-casing; a NEW blob never has anything meaningful written here.
//   v8 appends: 9x f32 (little-endian), the RAW Explosiveness sub-metrics themselves — attack speed
//     (M01), broadband onset bursts (M02), psychoacoustic loudness velocity (M03), transient-vs-sustained
//     balance (M04), onset density per beat (M05), wavelet energy gradients (M06), timbral shift velocity
//     (M07), kurtosis/peakedness (M08), micro-dynamic crest factor (M09), in that fixed order. NaN in any
//     slot means that metric wasn't computed (in practice, all 9 or none — see computeExplosivenessMetrics
//     in energy-analysis-core.js — but each slot is checked independently for robustness). These are
//     stored specifically so the composite score can be recomputed CLIENT-SIDE, ranked against whichever
//     tracks are currently visible — the 0-100 number itself is deliberately never part of this format.
// ~1.8 KB per fully-analyzed track vs ~2.5 KB+ as base64 JSON, and zero parse cost on the client.
// v1 blobs decode unchanged (bpm comes back null); v2-v4 blobs decode with melodic fields null; v8 is written now.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EnergyCodec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAGIC0 = 0x45, MAGIC1 = 0x4e, VERSION = 8, HEADER = 14, TAIL = 4;
  const BPM_SOURCES = [null, 'kick', 'envelope', 'hybrid']; // index <-> the u8 written/read in the tail
  const MELODIC_UNKNOWN = 255; // outside the valid 0-100 range, so unambiguous as a "not computed" sentinel
  const EXPLO_METRIC_KEYS = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09']; // fixed order, both directions

  function toU8(arr) {
    if (ArrayBuffer.isView(arr)) return arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const n = arr ? arr.length : 0, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = arr[i] & 0xff;
    return out;
  }

  function encode(entry) {
    const bi = toU8(entry.bucketIntensity), bp = toU8(entry.bassPresence), kt = toU8(entry.kickTicks);
    const tp = toU8(entry.treblePresence || []);
    const times = entry.kickTimes || [];
    const size = HEADER + bi.length + bp.length + kt.length + times.length * 4 + TAIL + 2 + tp.length + 3 + 3 + 1 + EXPLO_METRIC_KEYS.length * 4;
    const buf = new Uint8Array(size), dv = new DataView(buf.buffer);
    buf[0] = MAGIC0; buf[1] = MAGIC1; buf[2] = VERSION; buf[3] = 0;
    dv.setUint16(4, bi.length, true); dv.setUint16(6, bp.length, true); dv.setUint16(8, kt.length, true);
    dv.setUint32(10, times.length, true);
    let o = HEADER;
    buf.set(bi, o); o += bi.length;
    buf.set(bp, o); o += bp.length;
    buf.set(kt, o); o += kt.length;
    for (let i = 0; i < times.length; i++) { dv.setFloat32(o, times[i], true); o += 4; }
    const bpm = entry.bpm > 0 ? Math.min(65535, Math.round(entry.bpm * 100)) : 0;
    dv.setUint16(o, bpm, true); o += 2;
    buf[o] = bpm ? Math.max(0, Math.min(100, Math.round(entry.bpmConf || 0))) : 0; o += 1;
    buf[o] = bpm ? Math.max(0, BPM_SOURCES.indexOf(entry.bpmSource || null)) : 0; o += 1;
    dv.setUint16(o, tp.length, true); o += 2;
    buf.set(tp, o); o += tp.length;
    const clampMel = v => (v == null ? MELODIC_UNKNOWN : Math.max(0, Math.min(100, Math.round(v))));
    buf[o] = clampMel(entry.melodicScore); o += 1;
    buf[o] = clampMel(entry.melodicHarmonicity); o += 1;
    buf[o] = clampMel(entry.melodicMovement); o += 1;
    const subHz = entry.subHz > 0 ? Math.min(65535, Math.round(entry.subHz)) : 0;
    dv.setUint16(o, subHz, true); o += 2;
    buf[o] = subHz ? clampMel(entry.subQuality) : MELODIC_UNKNOWN; o += 1;
    buf[o] = clampMel(entry.explosiveness); o += 1; // dead field as of v8 — entry.explosiveness is never
                                                     // populated anymore, so this always writes 255 now
    const em = entry.explosivenessMetrics || {};
    for (const k of EXPLO_METRIC_KEYS) { dv.setFloat32(o, em[k] != null ? em[k] : NaN, true); o += 4; }
    return buf;
  }

  function decode(bytes) {
    const buf = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
    if (buf.length < HEADER || buf[0] !== MAGIC0 || buf[1] !== MAGIC1) throw new Error('not an energy blob');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const nBi = dv.getUint16(4, true), nBp = dv.getUint16(6, true), nKt = dv.getUint16(8, true), nT = dv.getUint32(10, true);
    let o = HEADER;
    const bucketIntensity = buf.slice(o, o + nBi); o += nBi;
    const bassPresence = buf.slice(o, o + nBp); o += nBp;
    const kickTicks = buf.slice(o, o + nKt); o += nKt;
    const kickTimes = new Array(nT);
    for (let i = 0; i < nT; i++) { kickTimes[i] = dv.getFloat32(o, true); o += 4; }
    let bpm = null, bpmConf = null, bpmSource = null, treblePresence = null;
    let melodicScore = null, melodicHarmonicity = null, melodicMovement = null;
    let subHz = null, subQuality = null, explosiveness = null, explosivenessMetrics = null;
    const tailStart = o; // v2/v3 tail is always exactly TAIL(4) bytes when present, regardless of whether bpm itself is known
    if (buf[2] >= 2 && tailStart + 3 <= buf.length) {
      const b = dv.getUint16(tailStart, true);
      if (b) { bpm = b / 100; bpmConf = buf[tailStart + 2]; if (buf[2] >= 3 && tailStart + 4 <= buf.length) bpmSource = BPM_SOURCES[buf[tailStart + 3]] || null; }
    }
    let trebleEnd = tailStart + TAIL;
    if (buf[2] >= 4) {
      const trebleStart = tailStart + TAIL;
      if (trebleStart + 2 <= buf.length) {
        const nTp = dv.getUint16(trebleStart, true), dataStart = trebleStart + 2;
        if (dataStart + nTp <= buf.length) { treblePresence = buf.slice(dataStart, dataStart + nTp); trebleEnd = dataStart + nTp; }
      }
    }
    if (buf[2] >= 5 && trebleEnd + 3 <= buf.length) {
      const unmel = v => (v === MELODIC_UNKNOWN ? null : v);
      melodicScore = unmel(buf[trebleEnd]); melodicHarmonicity = unmel(buf[trebleEnd + 1]); melodicMovement = unmel(buf[trebleEnd + 2]);
    }
    const melodicEnd = trebleEnd + (buf[2] >= 5 ? 3 : 0);
    if (buf[2] >= 6 && melodicEnd + 3 <= buf.length) {
      const h = dv.getUint16(melodicEnd, true);
      if (h) { subHz = h; const q = buf[melodicEnd + 2]; subQuality = q === MELODIC_UNKNOWN ? null : q; }
    }
    const subEnd = melodicEnd + (buf[2] >= 6 ? 3 : 0);
    if (buf[2] >= 7 && subEnd + 1 <= buf.length) {
      const e = buf[subEnd]; explosiveness = e === MELODIC_UNKNOWN ? null : e; // dead field as of v8 — read for backward compat only, never meaningful in a new blob
    }
    const explosivenessLegacyEnd = subEnd + (buf[2] >= 7 ? 1 : 0);
    if (buf[2] >= 8 && explosivenessLegacyEnd + EXPLO_METRIC_KEYS.length * 4 <= buf.length) {
      const em = {}; let anyPresent = false, oo = explosivenessLegacyEnd;
      for (const k of EXPLO_METRIC_KEYS) {
        const v = dv.getFloat32(oo, true); oo += 4;
        if (!Number.isNaN(v)) { em[k] = v; anyPresent = true; }
      }
      explosivenessMetrics = anyPresent ? em : null;
    }
    return { bucketIntensity, bassPresence, treblePresence, kickTicks, kickTimes, bpm, bpmConf, bpmSource, melodicScore, melodicHarmonicity, melodicMovement, subHz, subQuality, explosiveness, explosivenessMetrics };
  }

  // ---------- Tier-1 BPM: from confirmed kick timestamps only ----------
  // No decoding needed, so it can be back-filled over every stored analysis in seconds. Solid for
  // four-on-the-floor material with a steady kick; low confidence (or null) elsewhere, by design.
  const BPM_MIN = 84, BPM_MAX = 168; // kick-interval tempo is folded into this octave: a kick every other beat at 140 reads as 140, not 70
  function foldBpm(b) { while (b < BPM_MIN) b *= 2; while (b > BPM_MAX) b /= 2; return b; }
  function estimateBpmFromKicks(kickTimes, opts) {
    const minKicks = (opts && opts.minKicks) || 24;
    if (!kickTimes || kickTimes.length < minKicks) return null;
    const raw = Array.from(kickTimes).sort((a, b) => a - b);
    // A single kick can register on 2-3 consecutive sub-frames as its low band ramps up; keep only the
    // first hit of any cluster closer than 100 ms (no kick repeats faster than that).
    const t = [];
    for (const x of raw) if (!t.length || x - t[t.length - 1] >= 0.1) t.push(x);
    // Inter-onset intervals; ignore anything outside 0.2-2 s (300-30 BPM) — those are gaps, not beats.
    const ioi = [];
    for (let i = 1; i < t.length; i++) { const d = t[i] - t[i - 1]; if (d >= 0.2 && d <= 2.0) ioi.push(d); }
    if (ioi.length < minKicks - 1) return null;
    // Histogram at 2 ms, find the dominant bin cluster (bin ± 1 neighbour).
    const BIN = 0.002, hist = new Map();
    for (const d of ioi) { const k = Math.round(d / BIN); hist.set(k, (hist.get(k) || 0) + 1); }
    let bestK = -1, bestN = 0;
    for (const [k, n] of hist) { const m = n + (hist.get(k - 1) || 0) + (hist.get(k + 1) || 0); if (m > bestN) { bestN = m; bestK = k; } }
    if (bestK < 0) return null;
    // Refine: mean of all intervals near the winning bin (also catches kicks 2/3/4 beats apart). Kick times
    // are quantised to the 23 ms onset sub-frame, so the window is ±3% plus one sub-frame — averaging the
    // alternating short/long intervals that quantisation produces is exactly what recovers the true period.
    const center = bestK * BIN, tol = center * 0.03 + 0.025;
    let sum = 0, n = 0, agree = 0;
    for (const d of ioi) {
      let mult = 0;
      for (let m = 1; m <= 4; m++) if (Math.abs(d / m - center) <= tol) { mult = m; break; }
      if (mult) { sum += d / mult; n++; agree++; }
    }
    if (n < 8) return null;
    const period = sum / n;
    const bpm = foldBpm(60 / period);
    const conf = Math.round(100 * agree / ioi.length);
    if (conf < 35) return null; // the kicks don't agree on a grid — better blank than a confident-looking wrong number
    return { bpm: Math.round(bpm * 100) / 100, bpmConf: conf };
  }

  // base64 helpers that work in both browser and Node without pulling in Buffer semantics on the client
  function toBase64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str || '', 'base64'));
    const bin = atob(str || ''), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Legacy per-array base64 shape ({bucketIntensity:'...', bassPresence:'...', kickTicks:'...'}) used by
  // the old /state blob and by Backup zips. Both directions kept so old backups stay restorable.
  function fromLegacy(e) {
    if (!e) return null;
    const arr = v => (typeof v === 'string' ? fromBase64(v) : toU8(v || []));
    return { bucketIntensity: arr(e.bucketIntensity), bassPresence: arr(e.bassPresence), kickTicks: arr(e.kickTicks), kickTimes: e.kickTimes || [],
      treblePresence: e.treblePresence != null ? arr(e.treblePresence) : null,
      bpm: e.bpm > 0 ? Number(e.bpm) : null, bpmConf: e.bpmConf == null ? null : Number(e.bpmConf), bpmSource: e.bpmSource || null,
      melodicScore: e.melodicScore == null ? null : Number(e.melodicScore),
      melodicHarmonicity: e.melodicHarmonicity == null ? null : Number(e.melodicHarmonicity),
      melodicMovement: e.melodicMovement == null ? null : Number(e.melodicMovement),
      subHz: e.subHz == null ? null : Number(e.subHz),
      subQuality: e.subQuality == null ? null : Number(e.subQuality),
      explosivenessMetrics: (() => {
        if (!e.explosivenessMetrics) return null;
        const present = EXPLO_METRIC_KEYS.filter(k => e.explosivenessMetrics[k] != null);
        return present.length ? Object.fromEntries(present.map(k => [k, Number(e.explosivenessMetrics[k])])) : null;
      })() };
  }
  function toLegacy(entry, ts, intensity) {
    return { bucketIntensity: toBase64(toU8(entry.bucketIntensity)), bassPresence: toBase64(toU8(entry.bassPresence)),
      kickTicks: toBase64(toU8(entry.kickTicks)), kickTimes: entry.kickTimes || [], ts, intensity,
      treblePresence: entry.treblePresence != null ? toBase64(toU8(entry.treblePresence)) : undefined,
      bpm: entry.bpm == null ? undefined : entry.bpm, bpmConf: entry.bpmConf == null ? undefined : entry.bpmConf,
      bpmSource: entry.bpmSource || undefined,
      melodicScore: entry.melodicScore == null ? undefined : entry.melodicScore,
      melodicHarmonicity: entry.melodicHarmonicity == null ? undefined : entry.melodicHarmonicity,
      melodicMovement: entry.melodicMovement == null ? undefined : entry.melodicMovement,
      subHz: entry.subHz == null ? undefined : entry.subHz,
      subQuality: entry.subQuality == null ? undefined : entry.subQuality,
      explosivenessMetrics: entry.explosivenessMetrics || undefined };
  }

  return { encode, decode, toBase64, fromBase64, fromLegacy, toLegacy, estimateBpmFromKicks, VERSION };
});
