// energy-analysis-core.js — THE canonical copy of the actual DSP algorithm (intensity/melody/BPM/kick
// detection, sub-bass extension+quality). This is the ONE place to edit the algorithm itself.
//
// Both energy-worker.js (the browser Worker, loaded via importScripts) and the sync server's
// analysis-dsp.js (loaded via require(), for background server-side analysis) are thin wrappers around
// this exact file — neither contains any analysis logic of its own anymore. The server's copy of this
// specific file is meant to be a live-mounted volume (see docker-compose.yml), not baked into the Docker
// image at build time, specifically so an edit here takes effect on a `docker compose restart` — no
// image rebuild needed for an algorithm change, only for a change to the thin wrappers themselves (rare).
//
// Same UMD pattern energy-codec.js already uses: plain module.exports under Node (require), attaches to
// self.EnergyAnalysisCore under a Worker (importScripts). EnergyCodec is passed in as a parameter rather
// than assumed to be a bare global, so this works correctly regardless of which of those two environments
// loaded it first.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./energy-codec.js'));
  else root.EnergyAnalysisCore = factory(root.EnergyCodec);
})(typeof self !== 'undefined' ? self : this, function (EnergyCodec) {

  const ENERGY_BUCKETS = 600;
  const CENTROID_FFT_SIZE = 2048;
  const CENTROID_SAMPLES_PER_BUCKET = 4; // spread across the bucket instead of one snapshot
  // FFT tables, built once per size. Twiddles use the exact same complex-multiply recurrence the previous
  // inline version used per block, so results are bit-identical to analyses already stored — just not
  // recomputed 2,400 times per track.
  const fftTables = new Map();
  function fftTablesFor(n) {
    let t = fftTables.get(n); if (t) return t;
    const rev = new Uint32Array(n);
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; rev[i] = j; }
    const stages = [];
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr0 = Math.cos(ang), wi0 = Math.sin(ang), half = len >> 1;
      const wr = new Float64Array(half), wi = new Float64Array(half);
      let curWr = 1, curWi = 0;
      for (let k = 0; k < half; k++) { wr[k] = curWr; wi[k] = curWi; const nWr = curWr * wr0 - curWi * wi0, nWi = curWr * wi0 + curWi * wr0; curWr = nWr; curWi = nWi; }
      stages.push({ len, half, wr, wi });
    }
    t = { rev, stages }; fftTables.set(n, t); return t;
  }
  function fftInPlace(re, im) { // iterative radix-2 Cooley-Tukey; re/im length must be a power of 2
    const n = re.length, { rev, stages } = fftTablesFor(n);
    for (let i = 1; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (const { len, half, wr, wi } of stages) {
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const curWr = wr[k], curWi = wi[k], a = i + k, c = a + half;
          const ur = re[a], ui = im[a], xr = re[c], xi = im[c];
          const vr = xr * curWr - xi * curWi, vi = xr * curWi + xi * curWr;
          re[a] = ur + vr; im[a] = ui + vi;
          re[c] = ur - vr; im[c] = ui - vi;
        }
      }
    }
  }
  const HANN = (() => { const n = CENTROID_FFT_SIZE, w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); return w; })(); // Hann window — reduces spectral leakage
  const fftRe = new Float64Array(CENTROID_FFT_SIZE), fftIm = new Float64Array(CENTROID_FFT_SIZE); // scratch, reused for every window
  function spectralCentroidHz(samples, sampleRate, melodyLoHz, melodyHiHz) { // samples: a short window (any length <= FFT size, zero-padded)
    const n = CENTROID_FFT_SIZE, re = fftRe, im = fftIm, len = samples.length;
    for (let i = 0; i < len; i++) re[i] = samples[i] * HANN[i];
    for (let i = len; i < n; i++) re[i] = 0;
    im.fill(0);
    fftInPlace(re, im);
    let num = 0, den = 0, half = n / 2;
    const binHz = sampleRate / n;
    // Melodic-band stats reuse this exact same FFT pass — same cost as before, just extracting more from
    // magnitudes already computed, rather than a second pass over the audio.
    const loBin = Math.max(1, Math.round(melodyLoHz / binHz)), hiBin = Math.min(half - 1, Math.round(melodyHiHz / binHz));
    let melNum = 0, melDen = 0, logSum = 0, melBins = 0;
    for (let k = 1; k < half; k++) { // skip DC bin
      const r = re[k], i2 = im[k], mag = Math.sqrt(r * r + i2 * i2);
      num += (k * binHz) * mag;
      den += mag;
      if (k >= loBin && k <= hiBin) {
        melNum += (k * binHz) * mag; melDen += mag;
        logSum += Math.log(mag + 1e-9); melBins++; // +epsilon: log(0) is -Infinity, would poison the geometric mean for a genuinely silent bin
      }
    }
    // Spectral flatness = geometric mean / arithmetic mean of the magnitudes in the melodic band. Near 0 =
    // a few dominant peaks (a held note, a chord) = tonal; near 1 = energy spread evenly across the band =
    // noise-like. This is the harmonicity proxy — cheap, standard MIR feature, not pitch detection itself.
    const arithMean = melDen / Math.max(1, melBins);
    const flatness = melBins > 0 && arithMean > 0 ? Math.min(1, Math.exp(logSum / melBins) / arithMean) : 1;
    return {
      hz: den > 0 ? num / den : 0, energy: den, // unchanged — feeds the existing brightness/centroidNorms
      melodicHz: melDen > 0 ? melNum / melDen : 0, melodicEnergy: melDen, flatness,
    };
  }

  // ---------- Tier-2 BPM: onset-envelope autocorrelation ----------
  // Tier-1 (energy-codec.js, estimateBpmFromKicks) reads intervals between confirmed kick hits — fast,
  // no audio needed, but blank on anything without a steady low-end pulse (breakbeat, live drums, ambient,
  // long kickless intros). This is the fallback for those: a spectral-flux onset-strength envelope across
  // the WHOLE track, autocorrelated to find the dominant periodicity, independent of whether a "kick" was
  // ever confidently detected. Only run when Tier-1 didn't already give a confident answer — see the call
  // site — since it's the most expensive part of analysis by a wide margin (see the worker README/tests
  // for measured cost) and adds little over an already-confident kick-based read.
  const TEMPO_FFT_SIZE = 1024, TEMPO_HOP = 512; // 50% overlap, ~11.6ms hop @44.1kHz — plenty of resolution for a *tempo* (not onset-time) estimate
  const TEMPO_BPM_MIN = 60, TEMPO_BPM_MAX = 200; // wider net than Tier-1's dance-music fold — this is often the only estimate for slower/faster material
  const TEMPO_HANN = (() => { const n = TEMPO_FFT_SIZE, w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); return w; })();
  const tempoRe = new Float64Array(TEMPO_FFT_SIZE), tempoIm = new Float64Array(TEMPO_FFT_SIZE);
  function spectralFluxEnvelope(data, sampleRate) {
    const n = TEMPO_FFT_SIZE, half = n >> 1;
    const nFrames = Math.max(0, Math.floor((data.length - n) / TEMPO_HOP) + 1);
    const env = new Float32Array(nFrames), prevMag = new Float64Array(half);
    for (let f = 0; f < nFrames; f++) {
      const off = f * TEMPO_HOP;
      for (let i = 0; i < n; i++) tempoRe[i] = data[off + i] * TEMPO_HANN[i];
      tempoIm.fill(0);
      fftInPlace(tempoRe, tempoIm);
      let flux = 0;
      for (let k = 1; k < half; k++) { // half-wave rectified: only rising energy counts as an onset, falling doesn't
        const mag = Math.sqrt(tempoRe[k] * tempoRe[k] + tempoIm[k] * tempoIm[k]);
        const d = mag - prevMag[k];
        if (d > 0) flux += d;
        prevMag[k] = mag;
      }
      env[f] = flux;
    }
    return env;
  }
  function estimateTempoFromEnvelope(data, sampleRate) {
    const env = spectralFluxEnvelope(data, sampleRate);
    const hopSec = TEMPO_HOP / sampleRate;
    const minLag = Math.max(1, Math.floor(60 / TEMPO_BPM_MAX / hopSec));
    const maxLag = Math.min(env.length - 1, Math.ceil(60 / TEMPO_BPM_MIN / hopSec));
    if (maxLag <= minLag) return null; // track too short to see even one full bar at the slowest tempo considered
    let mean = 0; for (let i = 0; i < env.length; i++) mean += env[i]; mean /= env.length;
    const centered = new Float64Array(env.length);
    for (let i = 0; i < env.length; i++) centered[i] = env[i] - mean; // mean-removed so lag 0's huge autocorrelation doesn't bias neighbouring lags
    const nLags = maxLag - minLag + 1, ac = new Float64Array(nLags);
    for (let li = 0; li < nLags; li++) {
      const lag = minLag + li;
      let s = 0;
      for (let i = 0; i + lag < centered.length; i++) s += centered[i] * centered[i + lag];
      ac[li] = s;
    }
    // Pick the shortest lag among the strong local peaks, not simply the tallest bar anywhere in range.
    // Measured on a plain click track at a known 128 BPM: the peak at the TRUE period (lag ≈40 frames) was
    // real but *smaller* than the peak at exactly double that period (lag ≈81) — a very common property of
    // autocorrelating a pulse-like signal (every other pulse reinforces the half-tempo lag too), not a
    // one-off quirk of this signal. Always trusting the tallest bar would systematically halve the tempo on
    // exactly this kind of material.
    const peaks = [];
    for (let i = 1; i < nLags - 1; i++) if (ac[i] > ac[i - 1] && ac[i] >= ac[i + 1]) peaks.push(i);
    let bestI = -1, bestV = -Infinity;
    if (peaks.length) {
      let peakMax = -Infinity; for (const i of peaks) if (ac[i] > peakMax) peakMax = ac[i];
      const STRONG_ENOUGH = 0.7;
      bestI = peaks.find(i => ac[i] >= peakMax * STRONG_ENOUGH);
      if (bestI === undefined) bestI = peaks.reduce((a, b) => ac[b] > ac[a] ? b : a);
      bestV = ac[bestI];
    } else { // degenerate/monotonic range, no interior local max at all — fall back to the plain global max
      for (let i = 0; i < nLags; i++) if (ac[i] > bestV) { bestV = ac[i]; bestI = i; }
    }
    if (bestI < 0) return null;
    let refined = bestI; // parabolic interpolation around the peak for sub-lag (sub-BPM) precision
    if (bestI > 0 && bestI < nLags - 1) {
      const y0 = ac[bestI - 1], y1 = ac[bestI], y2 = ac[bestI + 1], denom = y0 - 2 * y1 + y2;
      if (denom !== 0) refined = bestI + 0.5 * (y0 - y2) / denom;
    }
    const bpm = 60 / ((minLag + refined) * hopSec);
    // Confidence from how much the winning peak stands out over the rest of the searched range — a sharp,
    // dominant peak means a clear pulse; a flat autocorrelation means the track doesn't have one (ambient,
    // free-form, heavily rubato), and the number should be trusted less accordingly.
    let acMean = 0, acMax = -Infinity, acMin = Infinity;
    for (let i = 0; i < nLags; i++) { acMean += ac[i]; if (ac[i] > acMax) acMax = ac[i]; if (ac[i] < acMin) acMin = ac[i]; }
    acMean /= nLags;
    const range = acMax - acMin;
    const prominence = range > 0 ? (bestV - acMean) / range : 0;
    const conf = Math.max(0, Math.min(100, Math.round(prominence * 140)));
    return { bpm, conf };
  }
  // Combines Tier-1 (kick intervals) and Tier-2 (envelope autocorrelation). With the gating above, Tier-2
  // only ever runs when Tier-1 came back null, so in practice this is always called with at most one of the
  // two present — the tier1-and-tier2-both-present branch below is dead code on the default path today, but
  // stays in (and is directly unit-tested) so a future looser gate — "also cross-check low-confidence Tier-1
  // reads" — is a one-line change to the condition above, not a redesign.
  function combineBpm(tier1, tier2) {
    if (!tier2) return tier1 ? { bpm: tier1.bpm, bpmConf: tier1.bpmConf, bpmSource: 'kick' } : null;
    if (tier1) {
      // Envelope autocorrelation is prone to octave errors (locking onto double or half the true tempo,
      // e.g. hi-hats at 2x the kick rate dominating the flux signal) — the kick-based anchor, when present,
      // resolves which octave is right rather than guessing from a generic prior.
      let best = tier2.bpm, bestDiff = Infinity;
      for (const c of [tier2.bpm, tier2.bpm * 2, tier2.bpm / 2]) {
        const diff = Math.abs(Math.log2(c / tier1.bpm));
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      }
      if (bestDiff < 0.08) { // the two methods substantially agree (within ~8%, allowing for tempo drift/rounding) — high-confidence hybrid
        return { bpm: Math.round((best + tier1.bpm) / 2 * 100) / 100, bpmConf: Math.max(tier1.bpmConf, tier2.conf), bpmSource: 'hybrid' };
      }
      return { bpm: tier1.bpm, bpmConf: tier1.bpmConf, bpmSource: 'kick' }; // real disagreement — the kick anchor is the more reliable signal, trust it
    }
    // No kick anchor at all: report the envelope estimate as-is, with reduced confidence since nothing
    // checked it for an octave error.
    return { bpm: Math.round(tier2.bpm * 100) / 100, bpmConf: Math.round(tier2.conf * 0.7), bpmSource: 'envelope' };
  }

  const ONSET_FRAME = 1024;  // ~23ms @44.1kHz sub-frames for onset/density detection
  const ONSET_RATIO = 1.3;   // a 30% jump in sub-frame RMS over the previous sub-frame counts as an onset
  const ONSET_FLOOR = 0.01;  // ignore near-silence so noise floor never triggers false onsets
  const BASS_CUTOFF_HZ = 150; // one-pole low-pass approximating kick/bass range, for continuous onset timing
  function percentile(values, p) { // p in [0,100]
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function otsuThreshold(values) { // returns {threshold, eta}. eta measures how well-separated the
    // two groups actually are (~0 = no real split exists, ~1 = clean bimodal split) — Otsu always
    // returns *some* threshold even when the distribution is one uniform cluster, so eta is what
    // tells you whether to trust that threshold at all.
    const hist = new Array(256).fill(0);
    for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
    const total = values.length;
    const p = hist.map(c => c / total);
    let meanAll = 0;
    for (let t = 0; t < 256; t++) meanAll += t * p[t];
    let totalVar = 0;
    for (let t = 0; t < 256; t++) totalVar += p[t] * (t - meanAll) * (t - meanAll);
    let sumB = 0, wB = 0, maxVar = 0, threshold = 0;
    for (let t = 0; t < 256; t++) {
      wB += p[t];
      if (wB === 0) continue;
      const wF = 1 - wB;
      if (wF <= 0) break;
      sumB += t * p[t];
      const mB = sumB / wB, mF = (meanAll - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
    }
    return { threshold, eta: totalVar > 0 ? maxVar / totalVar : 0 };
  }
  function computeEnergyProfile(data, sampleRate, trebleCutoffHz, melodyLoHz, melodyHiHz) { // data: Float32Array of one channel (plenty for a shape overview)
    trebleCutoffHz = trebleCutoffHz > 0 ? trebleCutoffHz : 10000; // configurable — see the settings panel; this default only covers calls that omit it
    melodyLoHz = melodyLoHz > 0 ? melodyLoHz : 200; melodyHiHz = melodyHiHz > melodyLoHz ? melodyHiHz : 2000;
    const total = data.length;
    const bucketSize = Math.max(1, Math.floor(total / ENERGY_BUCKETS));
    const loud = new Float32Array(ENERGY_BUCKETS), bucketPeak = new Float32Array(ENERGY_BUCKETS);
    const centroidNorms = new Float32Array(ENERGY_BUCKETS), onsetCounts = new Float32Array(ENERGY_BUCKETS);
    const bassRaw = new Float32Array(ENERGY_BUCKETS), bassOnsetCounts = new Float32Array(ENERGY_BUCKETS);
    let bucketMax = 0, maxOnsetCount = 0, totalOnsets = 0, bassMax = 0;
    let sumSqAll = 0, peakAll = 0, sumSqHP = 0, prev = 0; // running totals for the scalar score
    let bassSumSqAll = 0; // track-wide low-band energy, for the scalar score's bass-share term (separate from the
                           // per-bucket bassRaw/bassPresence used for the waveform's bottom half and kick detection)
    // Melody-score accumulators: energy-weighted across every small FFT window already being computed for
    // brightness below (~2,400 of them per track) — no extra FFT passes, just extra arithmetic on magnitudes
    // that were being computed anyway. See spectralCentroidHz for the per-window flatness/melodic-centroid math.
    let harmSumW = 0, harmWeight = 0; // energy-weighted mean of (1-flatness) -> "how tonal is the melodic band, on average"
    let melHzSumW = 0, melHzSqSumW = 0, melWeight = 0; // energy-weighted mean/variance of the melodic-band centroid -> "how much does that tone move"
    let totalSpectralEnergy = 0; // full-spectrum energy across the same windows — the denominator that tells a real melodic-band signal apart from mere FFT leakage from content well outside the band (see the melodicScore gate below)
    let subSumSq = 0, subCount = 0, prevSubRms = 0;        // running onset-detector state (crosses bucket boundaries)
    const bassAlpha = 1 - Math.exp(-2 * Math.PI * BASS_CUTOFF_HZ / sampleRate);
    let bassLp = 0, bassSubSumSq = 0, prevBassSubRms = 0;  // bass-band sub-frame state
    // Treble presence: the exact mirror of the bass-presence computation below, just a high-pass instead of
    // a low-pass, at a configurable cutoff. A one-pole high-pass is "signal minus its own low-pass" — same
    // one-pole filter already used for bass, just subtracted from the original rather than used directly.
    // A one-pole filter's usual "alpha = 1-exp(-2*pi*fc/fs)" coefficient is only accurate when fc is tiny
    // relative to the sample rate — true for bass at 150Hz, not for a cutoff that can go up to 18kHz on a
    // 44.1kHz signal. Verified directly: at a 10kHz cutoff with that formula, an 8kHz and a 20kHz tone came
    // out barely distinguishable (pass ratios 0.28 vs 0.39) — nowhere near the discrimination the cutoff is
    // supposed to provide. The bilinear-transform-exact coefficient below stays accurate across the whole
    // range instead of only near DC.
    const trebleWa = (2 * sampleRate) * Math.tan(Math.PI * trebleCutoffHz / sampleRate);
    const trebleY = trebleWa / (2 * sampleRate);
    const trebleAlpha = trebleY / (1 + trebleY);
    let trebleLp = 0;
    const trebleRaw = new Float32Array(ENERGY_BUCKETS);
    let trebleMax = 0;
    let hfSubSumSq = 0, prevHfSubRms = 0;                   // broadband "click" sub-frame state
    const HF_CLICK_WINDOW = 2; // sub-frames each side (~46ms) — a kick's click can land slightly
                                // before OR after the low-band hit depending on the specific kick
                                // sound design, so this needs to look both ways, not just backward.
    const PENDING_WIN = 2 * HF_CLICK_WINDOW + 1;
    const pending = []; // sliding buffer: {bassOnset, hfOnset, bucket, time} — evaluates its true middle element
    const kickTimesRaw = []; // precise seconds, for sample-accurate playback sync (bassOnsetCounts stays bucket-level, for the waveform)
    function flushPending(force) {
      while (pending.length >= PENDING_WIN) {
        const mid = pending[HF_CLICK_WINDOW];
        if (mid.bassOnset && pending.some(e => e.hfOnset)) { bassOnsetCounts[mid.bucket]++; kickTimesRaw.push(mid.time); }
        pending.shift();
      }
      if (force) {
        while (pending.length > 0) { // trailing sub-frames at the very end of the track — whatever window remains
          const head = pending[0];
          if (head.bassOnset && pending.some(e => e.hfOnset)) { bassOnsetCounts[head.bucket]++; kickTimesRaw.push(head.time); }
          pending.shift();
        }
      }
    }
    for (let b = 0; b < ENERGY_BUCKETS; b++) {
      const start = b * bucketSize, end = Math.min(total, start + bucketSize);
      let sumSq = 0, peakInBucket = 0, onsetsInBucket = 0, sumSqBassLp = 0, sumSqTreble = 0;
      for (let i = start; i < end; i++) {
        const v = data[i], vv = v * v;
        sumSq += vv;
        sumSqAll += vv;
        const av = v < 0 ? -v : v;
        if (av > peakAll) peakAll = av;
        if (av > peakInBucket) peakInBucket = av;
        const diff = v - prev, dd = diff * diff; prev = v; // first-difference = cheap high-frequency ("click") proxy
        sumSqHP += dd;

        bassLp += bassAlpha * (v - bassLp);
        const bb = bassLp * bassLp;
        sumSqBassLp += bb;
        bassSumSqAll += bb;

        trebleLp += trebleAlpha * (v - trebleLp); // low-pass at the cutoff...
        const th = v - trebleLp;                  // ...subtracted from the signal = everything above it
        sumSqTreble += th * th;

        // Three onset detectors sharing one sub-frame clock, since they always stay in lockstep:
        // full-band (density), bass-band (kick candidate), and broadband-click (kick confirmation).
        subSumSq += vv;
        bassSubSumSq += bb;
        hfSubSumSq += dd;
        subCount++;
        if (subCount >= ONSET_FRAME) {
          const subRms = Math.sqrt(subSumSq / subCount);
          if (subRms > ONSET_FLOOR && subRms > prevSubRms * ONSET_RATIO) { onsetsInBucket++; totalOnsets++; }
          prevSubRms = subRms;

          const bSubRms = Math.sqrt(bassSubSumSq / subCount);
          const bassOnsetNow = bSubRms > prevBassSubRms * ONSET_RATIO;
          prevBassSubRms = bSubRms;

          const hfSubRms = Math.sqrt(hfSubSumSq / subCount);
          const hfOnsetNow = hfSubRms > prevHfSubRms * ONSET_RATIO;
          prevHfSubRms = hfSubRms;

          // A kick needs BOTH: a low-band jump AND a coincident broadband click, within a small
          // window on either side — not just this-or-the-previous sub-frame. A plain bass-note
          // onset or a sidechain swell has the former without the latter; a real kick's transient
          // has both, close together in time (but not always in the exact same instant).
          pending.push({ bassOnset: bassOnsetNow, hfOnset: hfOnsetNow, bucket: b, time: i / sampleRate });
          flushPending(false);

          subSumSq = 0; bassSubSumSq = 0; hfSubSumSq = 0; subCount = 0;
        }
      }
      const rms = end > start ? Math.sqrt(sumSq / (end - start)) : 0;
      loud[b] = rms; bucketPeak[b] = peakInBucket;
      if (rms > bucketMax) bucketMax = rms;
      onsetCounts[b] = onsetsInBucket;
      if (onsetsInBucket > maxOnsetCount) maxOnsetCount = onsetsInBucket;
      bassRaw[b] = end > start ? Math.sqrt(sumSqBassLp / (end - start)) : 0;
      if (bassRaw[b] > bassMax) bassMax = bassRaw[b];
      trebleRaw[b] = end > start ? Math.sqrt(sumSqTreble / (end - start)) : 0;
      if (trebleRaw[b] > trebleMax) trebleMax = trebleRaw[b];

      // brightness for this bucket: energy-weighted average of several small FFTs spread across
      // the bucket's full span. A loud moment now correctly dominates the reading over quiet
      // filler, the way a real windowed centroid over that whole span naturally would — a flat
      // unweighted average was the earlier bug that washed out genuinely bass-heavy buckets.
      const bucketSpan = Math.max(1, end - start);
      let wSum = 0, wDen = 0;
      for (let s = 0; s < CENTROID_SAMPLES_PER_BUCKET; s++) {
        const frac = (s + 0.5) / CENTROID_SAMPLES_PER_BUCKET; // evenly spaced within the bucket
        const center = start + Math.floor(frac * bucketSpan);
        let winStart = center - (CENTROID_FFT_SIZE >> 1);
        if (winStart < 0) winStart = 0;
        if (winStart + CENTROID_FFT_SIZE > total) winStart = Math.max(0, total - CENTROID_FFT_SIZE);
        const { hz, energy, melodicHz, melodicEnergy, flatness } = spectralCentroidHz(data.subarray(winStart, winStart + CENTROID_FFT_SIZE), sampleRate, melodyLoHz, melodyHiHz);
        const norm = Math.min(1, Math.max(0, (hz - 200) / (5000 - 200))); // heuristic: ~200Hz(dark)-5kHz(bright)
        wSum += norm * energy; wDen += energy;
        harmSumW += (1 - flatness) * melodicEnergy; harmWeight += melodicEnergy;
        totalSpectralEnergy += energy;
        // Pitch perception is logarithmic — an octave jump is "the same size" whether it happens at 100Hz
        // or 1000Hz, but a LINEAR Hz difference is 10x bigger for the second case. Accumulating in log2
        // space (octaves) instead of raw Hz keeps movement comparable across registers; verified directly
        // against a synthetic arpeggio — linear Hz stddev for a clean one-octave 4-note arpeggio came out
        // to a modest 96Hz (understating it), while log2 stddev came out to 0.365 octaves, which properly
        // reflects "this spans a full octave" regardless of where in the spectrum it sits.
        if (melodicEnergy > 0) { // guard: log2(0) is -Infinity, and 0 * -Infinity is NaN even though the weight would otherwise zero it out
          const logHz = Math.log2(melodicHz);
          melHzSumW += logHz * melodicEnergy; melHzSqSumW += logHz * logHz * melodicEnergy; melWeight += melodicEnergy;
        }
      }
      centroidNorms[b] = wDen > 0 ? wSum / wDen : 0;

    }
    flushPending(true); // credit any trailing sub-frames near the end of the track with whatever lookahead is available

    // Near-silent windows still give an unreliable centroid even when energy-weighted (nothing to
    // weight). Carry forward the last trustworthy reading through those quiet buckets, then run a
    // 3-tap median to kill any remaining single-bucket outlier without touching genuine multi-bucket
    // trends (a real filter sweep/build).
    const quietThresh = bucketMax * 0.12;
    let lastGood = 0;
    for (let b = 0; b < ENERGY_BUCKETS; b++) {
      if (loud[b] < quietThresh) centroidNorms[b] = lastGood;
      else lastGood = centroidNorms[b];
    }
    const brightSmoothed = centroidNorms.slice();
    for (let b = 1; b < ENERGY_BUCKETS - 1; b++) {
      const trio = [centroidNorms[b - 1], centroidNorms[b], centroidNorms[b + 1]].sort((a, c) => a - c);
      brightSmoothed[b] = trio[1];
    }

    // Local punch per bucket (peak-in-bucket / rms-in-bucket), same heuristic range as the track-level version.
    const crestBuckets = new Float32Array(ENERGY_BUCKETS);
    for (let b = 0; b < ENERGY_BUCKETS; b++) {
      const cf = loud[b] > 0 ? bucketPeak[b] / loud[b] : 0;
      crestBuckets[b] = Math.min(1, Math.max(0, (cf - 1.5) / (6 - 1.5)));
    }
    // Local density: onset count per bucket, relative to this track's own busiest bucket (for strip contrast).
    const densityBuckets = Array.from(onsetCounts, c => maxOnsetCount > 0 ? c / maxOnsetCount : 0);
    const loudNorm = Array.from(loud, v => bucketMax > 0 ? v / bucketMax : 0);

    // One unified per-bucket Intensity value — same 4-ingredient recipe as the scalar score below,
    // just computed locally — drives both the strip's height and its color together, so "tall and
    // hot" always means the same thing: this moment is powerful, not just loud or just bright.
    const bucketIntensity = loudNorm.map((lv, b) =>
      Math.round(((lv + crestBuckets[b] + brightSmoothed[b] + densityBuckets[b]) / 4) * 255));

    // Bass/kick presence — deliberately kept separate from Intensity, not blended into it.
    // A break can be just as loud/bright/busy as a drop (risers, sweeps, busy hats) while the
    // bass is completely silent, so a blended score can't tell them apart. This can.
    const bassPresence = Array.from(bassRaw, v => Math.round((bassMax > 0 ? v / bassMax : 0) * 255));
    const treblePresence = Array.from(trebleRaw, v => Math.round((trebleMax > 0 ? v / trebleMax : 0) * 255));

    // Kick hits: the low-passed onset detector alone isn't reliable during quiet bass moments (small
    // fluctuations in near-silence can still register as "jumps"), so only trust a detected onset in
    // a bucket where bass presence is genuinely high — "high" judged relative to THIS track's own
    // distribution (Otsu's method), not a fixed number. A slow build-up can sit at moderate presence
    // for a while before the bass really lands; a fixed threshold can't tell those apart per-track,
    // an adaptive one can.
    const { threshold: otsuTh, eta } = otsuThreshold(bassPresence);
    // If bass is essentially present throughout (no real "quiet" cluster), Otsu still returns some
    // threshold — right through the middle of that one stable cluster — which would falsely gate
    // out roughly half of genuinely-present bass. eta tells us whether the split is real; below
    // ~0.7 it isn't, so fall back to a low percentile of this track's own range instead, which only
    // excludes genuinely low readings rather than arbitrarily bisecting a uniform signal.
    const bassGate = eta > 0.7 ? otsuTh : percentile(bassPresence, 10);
    const rawKickTicks = bassOnsetCounts.map((c, b) => (c > 0 && bassPresence[b] > bassGate) ? 1 : 0);
    // A single isolated "on" bucket with no on-neighbor on either side is far more likely a one-off
    // coincidental false positive than a real sustained kick section, which always runs several
    // buckets long. Suppress those, keep everything else untouched.
    const kickTicks = Array.from(rawKickTicks, (v, b) => {
      if (!v) return 0;
      const left = b > 0 ? rawKickTicks[b - 1] : 0, right = b < rawKickTicks.length - 1 ? rawKickTicks[b + 1] : 0;
      return (left || right) ? 1 : 0;
    });

    const rmsAll = total > 0 ? Math.sqrt(sumSqAll / total) : 0;
    const hpRms = total > 0 ? Math.sqrt(sumSqHP / total) : 0;
    const bassRmsAll = total > 0 ? Math.sqrt(bassSumSqAll / total) : 0;
    const crestFactor = rmsAll > 0 ? peakAll / rmsAll : 0;      // punchiness — heuristic range ~1.5-6
    const hfRatio = rmsAll > 0 ? hpRms / rmsAll : 0;             // brightness (cheap proxy) — heuristic range ~0.05-0.35
    const crestNorm = Math.min(1, Math.max(0, (crestFactor - 1.5) / (6 - 1.5)));
    const hfNorm = Math.min(1, Math.max(0, (hfRatio - 0.05) / (0.35 - 0.05)));
    const centroidNorm = brightSmoothed.reduce((s, v) => s + v, 0) / ENERGY_BUCKETS; // brightness, already 0-1
    const durationSec = total / sampleRate;
    const onsetsPerSec = durationSec > 0 ? totalOnsets / durationSec : 0;
    const densityNorm = Math.min(1, Math.max(0, onsetsPerSec / 8)); // heuristic: ~8 onsets/sec = very busy/dense
    // Absolute loudness (dBFS-ish, via the track's own RMS) — deliberately new. Everything else above is a
    // *ratio* (peak-to-average, high-to-average, brightness-vs-own-brightness), so a hyper-compressed, bass-heavy
    // master and a headroomy, dynamic one can land on the same crest/brightness numbers for entirely different
    // reasons. Ratios alone can't tell "mastered hot and hits hard" from "mixed quiet and sounds sparse" apart;
    // this term is what actually distinguishes them.
    const rmsDb = rmsAll > 0 ? 20 * Math.log10(rmsAll) : -60;
    const loudnessNorm = Math.min(1, Math.max(0, (rmsDb - (-30)) / ((-8) - (-30)))); // heuristic range: -30dBFS(quiet) to -8dBFS(hot/limited)
    // Low-end share of the total signal — also new. A dark, sub-heavy master reads as "calm" on the brightness
    // terms alone; this gives deep bass a positive vote instead of only ever being penalized for not being bright.
    const bassShare = rmsAll > 0 ? bassRmsAll / rmsAll : 0;
    const bassShareNorm = Math.min(1, Math.max(0, (bassShare - 0.15) / (0.55 - 0.15))); // heuristic range
    // Weights sum to 1. Loudness + bass-share now carry real weight (were 0 before — the exact gap that let
    // mix/mastering style masquerade as "energy"); crest factor is kept but demoted rather than dropped, since
    // it's still a useful sparse-vs-wall-of-sound signal, just an unreliable energy signal on its own.
    const intensity = Math.round((
      loudnessNorm * 0.30 +
      bassShareNorm * 0.20 +
      densityNorm * 0.20 +
      crestNorm * 0.10 +
      hfNorm * 0.10 +
      centroidNorm * 0.10
    ) * 100);
    // Melody score: a rough proxy, not pitch detection. Two ingredients, both energy-weighted averages over
    // every small FFT window already computed above (no new audio pass):
    //  - harmonicity: how tonal the melodic band is on average (near 1 = clear peaks/notes, near 0 = noise-
    //    like) — a heavy rumble or a wall of distortion scores low here even if it's loud.
    //  - movement: how much the melodic band's own centroid wanders over the track, normalized against an
    //    assumed "a lot of movement" reference of 400Hz of standard deviation within the melodic band. A
    //    single sustained drone/pad scores low here even if it's perfectly tonal; a lead line or chord
    //    progression that hops around scores higher.
    // Known failure modes, on purpose not hidden from the score's consumers: a resonant/filter-swept bassline
    // can show real movement without being "melodic" in the musical sense (one note reshaped, not a sequence
    // of notes), and a slow, sparse melody can show little movement within a short analysis window despite
    // being genuinely melodic. Treat this as a rough sort signal for the extremes, not a fine-grained score.
    const harmonicity = harmWeight > 0 ? Math.max(0, Math.min(1, harmSumW / harmWeight)) : 0;
    // melHzSumW/melHzSqSumW are now accumulated in log2(Hz) — see the comment at the accumulation site —
    // so this variance is in octaves², not Hz². 0.5 octaves of standard deviation is the "fully high
    // movement" reference: a real 4-note one-octave arpeggio measured at 0.365 octaves directly.
    const melHzMean = melWeight > 0 ? melHzSumW / melWeight : 0;
    const melHzVariance = melWeight > 0 ? Math.max(0, melHzSqSumW / melWeight - melHzMean * melHzMean) : 0;
    const movement = Math.max(0, Math.min(1, Math.sqrt(melHzVariance) / 0.5));
    // Require the melodic band to hold a genuinely meaningful share of the track's total spectral energy,
    // not just "greater than zero" — verified directly that a pure 40Hz tone (nowhere near the default
    // 200-2000Hz band) still leaks about 0.1% of its energy into the band via ordinary FFT window leakage,
    // which without this gate produced a fabricated-looking score instead of an honest "not measured here."
    // 2% is comfortably above that leakage floor and comfortably below what any of the in-band test
    // signals (arpeggio, noise, drone) actually measured.
    const hasMelodicSignal = totalSpectralEnergy > 0 && melWeight >= totalSpectralEnergy * 0.02;
    const melodicScore = hasMelodicSignal ? Math.round((harmonicity * 0.5 + movement * 0.5) * 100) : null;
    const melodicHarmonicity = hasMelodicSignal ? Math.round(harmonicity * 100) : null;
    const melodicMovement = hasMelodicSignal ? Math.round(movement * 100) : null;
    // Tier-2's envelope pass is the most expensive part of analysis by a wide margin (see the benchmarks in
    // the test suite) — measured against real synthetic material, Tier-1's own confidence sits well under
    // any threshold that would make Tier-2 an occasional fallback (a clean, textbook four-on-the-floor kick
    // pattern still only scores ~40), so gating on "confidence below N" would make Tier-2 the default path
    // on most tracks and roughly quadruple typical analysis time. Only run it when Tier-1 has nothing at
    // all — that's the case it exists for (breakbeat, live drums, ambient, no steady kick), and every track
    // where Tier-1 found *something* keeps today's cost.
    const tier1 = EnergyCodec.estimateBpmFromKicks(kickTimesRaw);
    const tier2 = tier1 ? null : estimateTempoFromEnvelope(data, sampleRate);
    const combinedBpm = combineBpm(tier1, tier2);
    return { bucketIntensity, bassPresence, treblePresence, kickTicks, intensity, kickTimes: kickTimesRaw,
      bpm: combinedBpm ? combinedBpm.bpm : null, bpmConf: combinedBpm ? combinedBpm.bpmConf : null, bpmSource: combinedBpm ? combinedBpm.bpmSource : null,
      melodicScore, melodicHarmonicity, melodicMovement };
  }

  // ---------- Sub-bass: extension (how low) + quality (mono-compatible, clean rolloff) ----------
  // A separate pass, not folded into computeEnergyProfile above, for two reasons: it needs a far larger FFT
  // window than anything else here (frequency resolution = sampleRate/fftSize, and sub-bass frequencies are
  // low enough that resolving them at all needs a long time-window — 2048, used everywhere else, gives only
  // ~21Hz/bin, too coarse to tell 30Hz from 50Hz), and it needs *both* channels, where every other
  // measurement in this file only ever sees one (see analyzeEnergy in player.js).
  const SUB_FFT_SIZE = 16384; // ~2.7Hz/bin @44.1kHz — resolves the 20-60Hz sub band into ~15 bins
  const SUB_HANN = (() => { const n = SUB_FFT_SIZE, w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); return w; })();
  const subRe = new Float64Array(SUB_FFT_SIZE), subIm = new Float64Array(SUB_FFT_SIZE);
  const SUB_MAX_WINDOWS = 96;       // cap on FFT windows analyzed per track — plenty for a stable averaged
                                     // spectrum without doing this on every possible window of a long DJ set
  const SUB_LO_HZ = 20, SUB_HI_HZ = 80;  // reference region for "how loud is the low end at its most present"
  const SUB_EXT_FLOOR_HZ = 20;           // don't report extension below the edge of human hearing
  const SUB_EXT_THRESHOLD_DB = 8;        // extension = lowest freq still within this many dB of the region's peak
  const SUBSONIC_REF_RATIO = 0.4;        // heuristic: below-20Hz energy at 40% of 20-60Hz energy or more scores ~0
  const MONO_LOWPASS_HZ = 90;            // channel correlation is measured after low-passing both channels here
  const QUALITY_CORR_WEIGHT = 0.65, QUALITY_SUBSONIC_WEIGHT = 0.35; // mono-correlation was the more heavily
                                     // emphasized pillar of every source consulted on this, hence the higher weight
  const SUB_SILENCE_GATE = 0.0005;  // a window's peak sample must clear this to count — keeps digital-silence
                                     // intros/outros/gaps from dragging the averaged spectrum toward "nothing extends"

  function computeSubBass(dataL, dataR, sampleRate) {
    const total = dataL.length;
    if (total < SUB_FFT_SIZE) return { subHz: null, subQuality: null }; // too short to resolve sub-bass at all

    // Averaged power spectrum across the track (sampled, not exhaustive — see SUB_MAX_WINDOWS), feeds both
    // extension and subsonic-rolloff below. Averaging in power (not dB) before the final log conversion is
    // the numerically correct way to average a spectrum across multiple windows.
    const step = Math.max(SUB_FFT_SIZE, Math.floor((total - SUB_FFT_SIZE) / SUB_MAX_WINDOWS) || SUB_FFT_SIZE);
    const half = SUB_FFT_SIZE / 2, binHz = sampleRate / SUB_FFT_SIZE;
    const powerSum = new Float64Array(half);
    let windows = 0;
    for (let off = 0; off + SUB_FFT_SIZE <= total; off += step) {
      let peak = 0;
      for (let i = 0; i < SUB_FFT_SIZE; i++) { const a = Math.abs(dataL[off + i]); if (a > peak) peak = a; }
      if (peak < SUB_SILENCE_GATE) continue;
      for (let i = 0; i < SUB_FFT_SIZE; i++) subRe[i] = dataL[off + i] * SUB_HANN[i];
      subIm.fill(0);
      fftInPlace(subRe, subIm);
      for (let k = 0; k < half; k++) powerSum[k] += subRe[k] * subRe[k] + subIm[k] * subIm[k];
      if (++windows >= SUB_MAX_WINDOWS) break;
    }
    if (windows === 0) return { subHz: null, subQuality: null }; // nothing but silence — can't measure

    // Extension: find the peak's own bin in the 20-80Hz reference region, then walk down FROM THAT BIN
    // (not from 80Hz) toward 20Hz, stopping at the lowest frequency still within SUB_EXT_THRESHOLD_DB of
    // the peak. Starting the walk at 80Hz instead of at the peak was an earlier bug here — it broke on the
    // very first iteration whenever the peak wasn't already right at 80Hz, reporting ~80Hz regardless of
    // where the track's content actually was; verified against synthetic pure-tone test signals before and
    // after this fix. A 3-bin moving average smooths single noisy bins so one dip doesn't falsely truncate
    // an otherwise cleanly-extending track.
    const loBin = Math.max(1, Math.round(SUB_LO_HZ / binHz)), hiBin = Math.min(half - 1, Math.round(SUB_HI_HZ / binHz));
    let peakPower = 0, peakBin = loBin;
    for (let k = loBin; k <= hiBin; k++) if (powerSum[k] > peakPower) { peakPower = powerSum[k]; peakBin = k; }
    const peakDb = 10 * Math.log10(peakPower + 1e-12);
    const smoothedDb = k => 10 * Math.log10((powerSum[Math.max(0, k - 1)] + powerSum[k] + powerSum[Math.min(half - 1, k + 1)]) / 3 + 1e-12);
    const floorBin = Math.max(1, Math.round(SUB_EXT_FLOOR_HZ / binHz));
    let extBin = peakBin;
    for (let k = peakBin; k >= floorBin; k--) { if (smoothedDb(k) >= peakDb - SUB_EXT_THRESHOLD_DB) extBin = k; else break; }
    const subHz = Math.round(extBin * binHz);

    // Subsonic rolloff: energy below 20Hz (unfiltered rumble/DC-adjacent junk a clean master would roll off)
    // relative to energy in the true 20-60Hz sub band.
    let energyBelow = 0, energyBand = 0;
    const bandHiBin = Math.min(half - 1, Math.round(60 / binHz));
    for (let k = 1; k < loBin; k++) energyBelow += powerSum[k];
    for (let k = loBin; k <= bandHiBin; k++) energyBand += powerSum[k];
    const subsonicRatio = energyBand > 0 ? energyBelow / energyBand : 0;
    const subsonicScore = Math.max(0, Math.min(1, 1 - subsonicRatio / SUBSONIC_REF_RATIO));

    // Mono correlation below ~90Hz: time-domain, one-pole low-pass per channel (same technique as
    // BASS_CUTOFF_HZ above, just applied to L and R separately), single pass, running Pearson correlation.
    // No R channel (mono source) is the best possible case for mono-compatibility by definition — full marks,
    // not "not measured" (unlike subHz/subsonic above, which genuinely can't be computed from an absence).
    let corrScore = 1;
    if (dataR && dataR.length === total) {
      const alpha = 1 - Math.exp(-2 * Math.PI * MONO_LOWPASS_HZ / sampleRate);
      let lpL = 0, lpR = 0, sumLR = 0, sumL2 = 0, sumR2 = 0;
      for (let i = 0; i < total; i++) {
        lpL += alpha * (dataL[i] - lpL); lpR += alpha * (dataR[i] - lpR);
        sumLR += lpL * lpR; sumL2 += lpL * lpL; sumR2 += lpR * lpR;
      }
      const denom = Math.sqrt(sumL2 * sumR2);
      // denom=0 (e.g. a hard-panned-mono or silent-in-one-channel source) has nothing to cancel — treat as fine.
      const correlation = denom > 0 ? sumLR / denom : 1;
      corrScore = Math.max(0, Math.min(1, correlation));
    }

    const subQuality = Math.round((corrScore * QUALITY_CORR_WEIGHT + subsonicScore * QUALITY_SUBSONIC_WEIGHT) * 100);
    return { subHz, subQuality };
  }

  // ==============================================================================================
  // Explosiveness (M01-M09) — "how suddenly and totally does this track change", distinct from
  // Intensity (loudness) and BPM (tempo). Deliberately its own frame size/hop and its own silence
  // gating, separate from computeEnergyProfile above — that pass is tuned for continuous
  // intensity-over-time and onset TIMING; this one is tuned for the STATISTICS of how extreme the
  // sharpest, most sudden moments in a track are, which called for different framing.
  // M01 (Energy Derivative), M02 (Spectral Flux), M05 (Onset Density), M07 (Centroid Velocity) share
  // one STFT pass below, since all four are frame-synchronized readings of the same spectrum — no
  // reason to compute the FFT four separate times. M04, M08, M09 are separate passes, each noted
  // where it's built.
  const EXPLO_FFT_SIZE = 2048, EXPLO_HOP = 512; // 75% overlap @44.1kHz ≈ 46ms frame / 11.6ms hop
  const EXPLO_HANN = (() => { const n = EXPLO_FFT_SIZE, w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); return w; })();
  const exploRe = new Float64Array(EXPLO_FFT_SIZE), exploIm = new Float64Array(EXPLO_FFT_SIZE);
  // Mean-squared-amplitude floor — frames below this are excluded from derivative/statistical metrics
  // so a silent intro/outro can't register as a huge percentage jump off a near-zero base.
  const EXPLO_SILENCE_GATE = 1e-6;

  function percentile(arr, p, alreadySorted = false) {
    if (!arr.length) return 0;
    const s = alreadySorted ? arr : Float64Array.from(arr).sort();
    const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
    return s[idx];
  }

  // One STFT pass producing everything M01/M02/M05/M07 need: per-frame energy, spectral flux against
  // the previous frame, and spectral centroid. curMag/prevMag are swapped each iteration rather than
  // reallocated, so this doesn't allocate per-frame.
  function explosivenessFrames(samples, sampleRate) {
    const N = EXPLO_FFT_SIZE, H = EXPLO_HOP, total = samples.length;
    if (total < N) return null;
    const frameCount = Math.floor((total - N) / H) + 1;
    const dt = H / sampleRate, half = N >> 1;
    const energies = new Float64Array(frameCount);   // E[m], mean squared amplitude — divided by N so
                                                       // this doesn't just scale with frame size
    const flux = new Float64Array(frameCount);        // SF[m]
    const centroidHz = new Float64Array(frameCount);  // C[m], in Hz
    let curMag = new Float64Array(half), prevMag = new Float64Array(half);

    for (let m = 0; m < frameCount; m++) {
      const off = m * H;
      let e = 0;
      for (let i = 0; i < N; i++) { const s = samples[off + i]; e += s * s; }
      energies[m] = e / N;

      for (let i = 0; i < N; i++) exploRe[i] = samples[off + i] * EXPLO_HANN[i];
      exploIm.fill(0);
      fftInPlace(exploRe, exploIm);

      let f = 0, weighted = 0, magSum = 0;
      for (let k = 0; k < half; k++) {
        const mag = Math.hypot(exploRe[k], exploIm[k]);
        curMag[k] = mag;
        if (m > 0) { const d = mag - prevMag[k]; if (d > 0) f += d; } // half-wave rectified — positive growth only
        weighted += k * mag; magSum += mag;
      }
      flux[m] = f;
      centroidHz[m] = magSum > 0 ? (weighted / magSum) * (sampleRate / N) : 0;

      const tmp = prevMag; prevMag = curMag; curMag = tmp; // swap, no reallocation
    }
    return { frameCount, dt, half, energies, flux, centroidHz };
  }

  function computeM01_M02_M05_M07(frames, bpm) {
    const { frameCount, dt, energies, flux, centroidHz } = frames;
    const energyDerivSeq = new Float64Array(frameCount);    // signed — only GROWTH counts as "explosive";
                                                              // a sudden drop to silence isn't
    const centroidDerivSeq = new Float64Array(frameCount);  // unsigned — a sudden shift EITHER way in
                                                              // timbre (brighter or darker) can feel sudden
    for (let m = 1; m < frameCount; m++) {
      // Excluded only when BOTH frames are silent (a meaningless noise-floor-vs-noise-floor comparison).
      // A silence -> sound transition is exactly the kind of moment this metric exists to capture, not
      // filter out — this is an ABSOLUTE difference, not a ratio, so there was never a divide-by-near-
      // zero risk to guard against by excluding it. An earlier version used OR here (excluding a pair if
      // EITHER frame was silent), which silently discarded the single sharpest transition in a
      // hard-onset test signal — caught by testing against exactly that case.
      if (energies[m] < EXPLO_SILENCE_GATE && energies[m - 1] < EXPLO_SILENCE_GATE) continue;
      energyDerivSeq[m] = energies[m] - energies[m - 1];
      centroidDerivSeq[m] = Math.abs(centroidHz[m] - centroidHz[m - 1]);
    }
    // Peak-pick local maxima that ALSO clear an adaptive threshold (median + k·MAD of the sequence
    // itself) — "is this a local max" alone isn't enough, since a perfectly steady tone still has tiny
    // frame-to-frame wiggles from windowing that each count as a "local maximum" despite being noise, not
    // signal. Confirmed directly: on a synthetic hard-onset test, local-maximum-only picking found 61
    // "peaks" for one genuine onset, of which 59 were sub-1.0 windowing noise from the steady portion of
    // the tone and only 2 were the actual onset (~7+) — so even a 90th percentile of that pool landed
    // squarely in the noise. Requiring the adaptive threshold too (the same technique already used for
    // the spectral-flux peaks just below) removes the noise cluster rather than just outvoting it with a
    // higher percentile.
    function peakValues(seq) {
      const positive = [];
      for (let m = 0; m < seq.length; m++) if (seq[m] > 0) positive.push(seq[m]);
      if (!positive.length) return [];
      const sorted = Float64Array.from(positive).sort();
      const med = percentile(sorted, 0.5, true);
      let madSum = 0; for (let i = 0; i < sorted.length; i++) madSum += Math.abs(sorted[i] - med);
      const thresh = med + 2.0 * (madSum / sorted.length);
      const out = [];
      for (let m = 1; m < seq.length - 1; m++) if (seq[m] > thresh && seq[m] >= seq[m - 1] && seq[m] >= seq[m + 1]) out.push(seq[m]);
      return out;
    }
    const energyPeaks = peakValues(energyDerivSeq).map(v => v / dt);
    const centroidPeaks = peakValues(centroidDerivSeq).map(v => v / dt);
    // Mean of the (now genuinely sparse) qualifying peaks, matching M02's own convention below, rather
    // than a percentile — with a real onset count in the single-to-low-double digits for a typical
    // track, a percentile over that few points is noisy in a way a plain mean isn't.
    const m01 = energyPeaks.length ? energyPeaks.reduce((a, b) => a + b, 0) / energyPeaks.length : 0;
    const m07 = centroidPeaks.length ? centroidPeaks.reduce((a, b) => a + b, 0) / centroidPeaks.length : 0;

    // Onset peak-picking: a frame is a candidate if it's a local max in SF[m] AND clears an ADAPTIVE
    // threshold (median + k·MAD of this track's own flux sequence) — robust to how busy a track is
    // overall, rather than one fixed global cutoff that would misfire on a quiet track.
    const sortedFlux = Float64Array.from(flux).sort();
    const med = percentile(sortedFlux, 0.5, true);
    let madSum = 0; for (let i = 0; i < flux.length; i++) madSum += Math.abs(flux[i] - med);
    const mad = madSum / (flux.length || 1);
    const threshold = med + 2.0 * mad;
    const peaks = [];
    for (let m = 1; m < frameCount - 1; m++) {
      if (flux[m] > threshold && flux[m] >= flux[m - 1] && flux[m] >= flux[m + 1]) peaks.push(flux[m]);
    }
    const m02 = peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : 0; // mean of the peaks
    const durationSec = frameCount * dt;
    const onsetsPerSec = durationSec > 0 ? peaks.length / durationSec : 0;
    // Onsets PER BEAT, not per second, whenever tempo is known — raw onsets/sec mostly just re-derives
    // BPM (a faster track has more events per second almost by definition), which is redundant with the
    // BPM column that already exists. Per-beat asks the more interesting question: busy *for its own
    // tempo*, not just fast. Falls back to raw onsets/sec only if BPM estimation failed for this track.
    const m05 = bpm > 0 ? onsetsPerSec / (bpm / 60) : onsetsPerSec;

    return { m01, m02, m05, m07, onsetCount: peaks.length };
  }

  // M08: excess kurtosis of the frame-energy sequence already computed above — "peakedness" of the
  // energy distribution. Smooth continuous signals cluster near their mean (low/negative kurtosis);
  // signals dominated by sharp bursts amid quiet gaps have a long tail (high positive kurtosis).
  // Deliberately does NOT exclude near-silent frames the way the derivative metrics do — this is
  // computing the SHAPE of the whole energy distribution, and "mostly quiet with occasional extreme
  // bursts" is precisely the pattern this metric exists to detect. Excluding the quiet frames removes
  // exactly the asymmetry that makes a bursty signal read as bursty: confirmed directly against a
  // synthetic sparse-burst signal, where excluding near-silent frames threw away 96% of the track and
  // left kurtosis computed over just the bursts themselves — which, being similar to each other, no
  // longer looked peaky at all.
  function computeM08(frames) {
    const { energies } = frames;
    if (energies.length < 8) return 0;
    let mean = 0; for (let i = 0; i < energies.length; i++) mean += energies[i]; mean /= energies.length;
    let m2 = 0, m4 = 0;
    for (let i = 0; i < energies.length; i++) { const d = energies[i] - mean, d2 = d * d; m2 += d2; m4 += d2 * d2; }
    m2 /= energies.length; m4 /= energies.length;
    return m2 > 0 ? (m4 / (m2 * m2)) - 3 : 0;
  }

  // M04: Transient-to-Sustained Energy Ratio, via median-filter-based harmonic/percussive separation —
  // the standard technique (Fitzgerald 2010; the same approach librosa's HPSS uses). A median filter
  // ALONG TIME for a given frequency bin estimates the "harmonic" (sustained/tonal) content at that bin
  // — it smooths away anything that only lasts a frame or two while preserving whatever holds steady
  // across many frames. A median filter ALONG FREQUENCY within one frame estimates the "percussive"
  // (transient/broadband) content — it smooths away narrow tonal peaks while preserving broadband
  // energy. Each bin's actual magnitude is then split between the two via a soft mask.
  // Uses a sliding window of only TSER_TIME_KERNEL frames, not the full track's spectrogram (which would
  // run 100MB+ for a typical track) — median filtering only ever looks at a local neighborhood anyway,
  // so this produces an identical result to holding everything in memory, just without the memory cost.
  const TSER_TIME_KERNEL = 17, TSER_FREQ_KERNEL = 17; // both odd, so each has one clear center bin/frame

  function medianOf(arr) { // arr.length is always odd here (both kernels above are odd), so the middle
                            // index after sorting is exactly the median, no averaging-of-two-middles needed.
                            // Sorts IN PLACE rather than copying first — safe because both of this
                            // function's only two callers (in computeTSER) pass a scratch buffer that's
                            // fully overwritten on every iteration before its next use anyway, so there's
                            // nothing to preserve. This was the single largest cost in the entire
                            // Explosiveness pipeline by a wide margin: for a 20-minute track this function
                            // is called on the order of 200 MILLION times (once per frequency bin per
                            // analysis frame, twice per bin), and the old Float64Array.from(arr) copy
                            // meant 200 million needless heap allocations — measured directly at ~201 of a
                            // ~228 second total, i.e. this one unnecessary copy was ~88% of the entire
                            // analysis cost for a long track.
                            // A hand-written insertion sort, not the built-in .sort(), for the actual
                            // sorting too — benchmarked directly at this exact array size and call volume:
                            // ~20% faster than the built-in (which still carries some general-purpose
                            // dispatch overhead even for a numeric-typed array), confirmed to produce
                            // identical output first. Insertion sort is normally a poor general-purpose
                            // choice (O(n^2)) but is genuinely competitive for an array this tiny (17
                            // elements) at this call volume, where avoiding any per-call overhead matters
                            // more than asymptotic complexity.
    for (let i = 1; i < arr.length; i++) {
      const v = arr[i];
      let j = i - 1;
      while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j--; }
      arr[j + 1] = v;
    }
    return arr[arr.length >> 1];
  }

  function computeTSER(samples, sampleRate, onProgress) {
    const report = onProgress || (() => {});
    const N = EXPLO_FFT_SIZE, H = EXPLO_HOP, total = samples.length;
    if (total < N) return 0;
    const frameCount = Math.floor((total - N) / H) + 1;
    const half = N >> 1;
    const K = TSER_TIME_KERNEL, radius = K >> 1;
    if (frameCount <= K) return 0; // too short for a meaningful windowed median

    function computeFrameMag(m) {
      const off = m * H, out = new Float64Array(half);
      for (let i = 0; i < N; i++) exploRe[i] = samples[off + i] * EXPLO_HANN[i];
      exploIm.fill(0);
      fftInPlace(exploRe, exploIm);
      for (let k = 0; k < half; k++) out[k] = Math.hypot(exploRe[k], exploIm[k]);
      return out;
    }

    const window = []; // sliding buffer of K consecutive frames' magnitude spectra
    for (let i = 0; i < K; i++) window.push(computeFrameMag(i));
    let nextToLoad = K;

    let sumHarmSq = 0, sumPercSq = 0;
    const timeBuf = new Float64Array(K);
    const freqRadius = TSER_FREQ_KERNEL >> 1;
    const freqBuf = new Float64Array(TSER_FREQ_KERNEL);

    const loopStart = radius, loopEnd = frameCount - radius, loopSpan = loopEnd - loopStart;
    const REPORT_EVERY = 500; // throttled — this loop runs on the order of 100K+ times for a long track,
                               // and calling onProgress every single iteration would add real overhead to
                               // the exact hot loop just optimized; checking every 500 iterations gives
                               // ~200 updates over a 20-minute track, frequent enough to look smooth
                               // without meaningfully affecting the loop's own cost.
    for (let center = radius; center < frameCount - radius; center++) {
      if ((center - loopStart) % REPORT_EVERY === 0) report((center - loopStart) / loopSpan);
      const centerMag = window[radius];
      // Skip near-silent frames entirely, not just let the epsilon absorb them — a long-running ratio
      // like this one is numerically unstable if silent stretches are allowed to drag the denominator
      // toward zero (confirmed directly: a mostly-silent test signal with only occasional bursts drove
      // sumHarmSq down near the epsilon floor, making the whole ratio blow up to an astronomical, not
      // just "high", value). Silence carries neither harmonic nor percussive energy — it should be
      // excluded from both sums, not treated as data.
      let frameEnergy = 0; for (let k = 0; k < half; k++) frameEnergy += centerMag[k] * centerMag[k];
      if (frameEnergy < EXPLO_SILENCE_GATE) { window.shift(); if (nextToLoad < frameCount) { window.push(computeFrameMag(nextToLoad)); nextToLoad++; } continue; }
      for (let k = 0; k < half; k++) {
        for (let t = 0; t < K; t++) timeBuf[t] = window[t][k];
        const harmEst = medianOf(timeBuf);
        let fc = 0;
        for (let f = -freqRadius; f <= freqRadius; f++) {
          const kk = k + f;
          freqBuf[fc++] = (kk >= 0 && kk < half) ? centerMag[kk] : 0;
        }
        const percEst = medianOf(freqBuf);
        // Soft (Wiener-like) mask, p=2 — splits this bin's actual magnitude between harmonic and
        // percussive in proportion to which estimate dominates, rather than a hard either/or assignment.
        const hp2 = harmEst * harmEst, pp2 = percEst * percEst, denom = hp2 + pp2;
        const harmFrac = denom > 0 ? hp2 / denom : 0.5;
        const mag = centerMag[k];
        const harmComp = mag * harmFrac, percComp = mag * (1 - harmFrac);
        sumHarmSq += harmComp * harmComp;
        sumPercSq += percComp * percComp;
      }
      window.shift();
      if (nextToLoad < frameCount) { window.push(computeFrameMag(nextToLoad)); nextToLoad++; }
    }

    // A fixed, tiny epsilon here (as the reference spec's formula literally shows it) blows up to an
    // unbounded, meaningless number whenever a track has genuinely ~zero harmonic content (pure noise or
    // pure percussion, no tonal component at all) — confirmed directly: sumHarmSq came out to EXACTLY 0
    // for a synthetic noise-only signal (correct HPSS behavior — the time-axis median filter is SUPPOSED
    // to reject sparse transients down to zero when there's no sustained tone at that bin), and dividing
    // a large sumPercSq by a fixed 1e-9 produced a value in the quintillions. Scaling the epsilon to a
    // small fraction of the track's own total energy instead keeps the ratio bounded (worst case ~1000,
    // still clearly "maximally percussive" after normalization) without measurably changing the result
    // for any track that has a normal, non-degenerate mix of both.
    return sumPercSq / (sumHarmSq + 0.001 * (sumHarmSq + sumPercSq) + 1e-9);
  }

  // M06: Wavelet Energy Gradient — a Continuous Wavelet Transform with a complex Morlet wavelet, evaluated
  // at a log-spaced set of scales spanning roughly 50Hz-8000Hz, then the maximum-across-scales energy
  // derivative at each point in time.
  //
  // Evaluated only at hop-spaced time points (the same WAVELET_HOP below, not every sample) rather than a
  // dense, continuous-time CWT — this is standard practice (identical in spirit to how an STFT is itself
  // already a discretized, hop-spaced version of a continuous-time transform), and here specifically
  // avoids needing FFT-based block convolution: direct time-domain correlation of the signal against each
  // scale's (finite-support, since a Morlet's Gaussian envelope decays to ~0 past a few standard
  // deviations) wavelet kernel, evaluated only at the sparse set of points actually needed, keeps this
  // tractable without the real bookkeeping risk of overlap-save block convolution. A full-signal, every-
  // sample CWT at native sample rate would need direct convolution costing roughly 1e11 operations for a
  // 5-minute track (checked before committing to this approach) — genuinely impractical.
  const WAVELET_OMEGA0 = 6;               // standard Morlet parameter — a reasonable time/frequency tradeoff
  const WAVELET_HOP = 1024;               // coarser than the main STFT hop (512) — a low-frequency scale's
                                           // own time resolution is already coarse (its kernel spans many
                                           // tens of milliseconds), so matching analysis hop to roughly the
                                           // wavelet's own effective resolution is principled, not a shortcut
  const WAVELET_NUM_SCALES = 12;
  const WAVELET_FREQ_LO = 50, WAVELET_FREQ_HI = 8000; // spans sub-bass through presence/brightness

  function buildMorletKernel(scaleA) {
    const supportRadius = Math.max(2, Math.round(4 * scaleA)); // 4 standard deviations of Gaussian support
    const len = supportRadius * 2 + 1;
    const re = new Float64Array(len), im = new Float64Array(len);
    let normSq = 0;
    for (let i = 0; i < len; i++) {
      const t = (i - supportRadius) / scaleA;
      const gauss = Math.exp(-(t * t) / 2);
      re[i] = gauss * Math.cos(WAVELET_OMEGA0 * t);
      im[i] = gauss * Math.sin(WAVELET_OMEGA0 * t);
      normSq += re[i] * re[i] + im[i] * im[i];
    }
    // Normalize to unit energy so different scales' output magnitudes are directly comparable to each
    // other — without this, larger (lower-frequency) kernels would trivially dominate just from having
    // more taps, independent of anything about the actual signal.
    const norm = Math.sqrt(normSq) || 1;
    for (let i = 0; i < len; i++) { re[i] /= norm; im[i] /= norm; }
    return { re, im, supportRadius };
  }

  function computeWaveletGradient(samples, sampleRate) {
    const total = samples.length;
    const timePoints = Math.floor(total / WAVELET_HOP);
    if (timePoints < 4) return 0;

    // Build all scales' kernels up front, log-spaced across the target frequency range.
    const kernels = [];
    for (let s = 0; s < WAVELET_NUM_SCALES; s++) {
      const t = s / (WAVELET_NUM_SCALES - 1);
      const freq = WAVELET_FREQ_LO * Math.pow(WAVELET_FREQ_HI / WAVELET_FREQ_LO, t); // log-spaced
      const scaleA = (WAVELET_OMEGA0 * sampleRate) / (2 * Math.PI * freq);
      kernels.push(buildMorletKernel(scaleA));
    }

    // Energy at each (scale, time point) — |W(a,b)|^2 via direct correlation.
    const energyByScale = kernels.map(() => new Float64Array(timePoints));
    for (let s = 0; s < kernels.length; s++) {
      const { re: kre, im: kim, supportRadius } = kernels[s];
      const out = energyByScale[s];
      for (let tp = 0; tp < timePoints; tp++) {
        const center = tp * WAVELET_HOP;
        const lo = Math.max(0, center - supportRadius), hi = Math.min(total - 1, center + supportRadius);
        let accRe = 0, accIm = 0;
        for (let n = lo; n <= hi; n++) {
          const ki = n - center + supportRadius;
          const x = samples[n];
          accRe += x * kre[ki];
          accIm += x * kim[ki]; // correlation against the wavelet's own (not conjugated) imaginary part is
                                 // equivalent to conjugate-correlation for a real-valued signal — the sign
                                 // convention doesn't affect the magnitude this metric actually uses
        }
        out[tp] = accRe * accRe + accIm * accIm;
      }
    }

    // At each time point, the derivative of energy at EACH scale, then the MAX across scales — "did any
    // scale show an extreme, sudden change right now", matching the reference spec's own framing of
    // simultaneous high- and low-frequency energy gradients.
    const dt = WAVELET_HOP / sampleRate;
    const maxDerivAtTime = new Float64Array(timePoints);
    for (let tp = 1; tp < timePoints; tp++) {
      let maxD = 0;
      const centerCur = tp * WAVELET_HOP, centerPrev = (tp - 1) * WAVELET_HOP;
      for (let s = 0; s < kernels.length; s++) {
        const { supportRadius } = kernels[s];
        // Skip this scale's contribution here if EITHER the current or previous time point's kernel
        // window would have been truncated at a signal boundary — a partial-support correlation is a
        // biased value, not directly comparable to a full-support neighbor, and comparing them produces a
        // spurious "jump" unrelated to the actual signal. Confirmed directly: this was producing the
        // single largest spike found anywhere in an otherwise perfectly steady test tone, at tp=1 — right
        // where the lower-frequency scales' kernels (which extend thousands of samples) don't yet have
        // full support near the very start of the signal.
        if (centerCur - supportRadius < 0 || centerCur + supportRadius > total - 1) continue;
        if (centerPrev - supportRadius < 0 || centerPrev + supportRadius > total - 1) continue;
        const d = Math.abs(energyByScale[s][tp] - energyByScale[s][tp - 1]) / dt;
        if (d > maxD) maxD = d;
      }
      maxDerivAtTime[tp] = maxD;
    }

    // Same threshold-gated peak-picking as M01/M07 — isolates genuine gradient spikes from ordinary
    // frame-to-frame variation, for the same reason verified there (a straight percentile-of-everything
    // is dominated by the much larger pool of ordinary frames on anything but a very short track).
    const positive = []; for (let i = 0; i < maxDerivAtTime.length; i++) if (maxDerivAtTime[i] > 0) positive.push(maxDerivAtTime[i]);
    if (!positive.length) return 0;
    const sorted = Float64Array.from(positive).sort();
    const med = percentile(sorted, 0.5, true);
    let madSum = 0; for (let i = 0; i < sorted.length; i++) madSum += Math.abs(sorted[i] - med);
    const thresh = med + 2.0 * (madSum / sorted.length);
    const peaks = [];
    for (let tp = 1; tp < maxDerivAtTime.length - 1; tp++) {
      if (maxDerivAtTime[tp] > thresh && maxDerivAtTime[tp] >= maxDerivAtTime[tp - 1] && maxDerivAtTime[tp] >= maxDerivAtTime[tp + 1]) peaks.push(maxDerivAtTime[tp]);
    }
    return peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : 0;
  }

  // M03: Psychoacoustic Loudness Velocity — a Zwicker-model-inspired approximation of perceptual
  // loudness (in Sone), differentiated over time. Three of its four stages are implemented against
  // formulas cross-checked against multiple independent published sources (Bark scale, the Terhardt
  // outer/middle-ear transfer function, the Schroeder spreading function — see each below for the exact
  // reference). The fourth stage (the specific-loudness power-law transform) has a genuinely ambiguous
  // scaling constant even in the primary literature — cross-checking it surfaced a researcher on an
  // acoustics mailing list who'd spent two days trying to pin down the same constant from Zwicker &
  // Fastl's own textbook without a clear answer. Rather than trust an uncertain number, that ONE constant
  // is calibrated here against a fixed, unambiguous, universally-cited reference point instead: a 1kHz
  // tone at 40dB SPL is 1 Sone BY DEFINITION of the Sone scale itself. This is a faithful approximation
  // of the real model's structure, calibrated against the one part of it that isn't in dispute — not a
  // certified bit-exact ISO 532B implementation, which isn't achievable without the paywalled standard
  // itself.
  //
  // Digital full-scale amplitude (1.0) is assumed to correspond to 100dB SPL, a common convention in
  // consumer-audio psychoacoustic modeling — an assumption, not a measurement, since there's no way to
  // know a track's actual playback level from the file alone.
  const ZWICKER_FS_SPL_DB = 100;
  const ZWICKER_NUM_BANDS = 24; // the full Bark scale, 0-24 Bark

  // Bark scale: z = 13*atan(0.00076*f) + 3.5*atan((f/7500)^2) — Zwicker & Terhardt's own closed-form
  // approximation, confirmed against multiple independent sources including a dedicated Bark-scale
  // reference calculator.
  function hzToBark(f) { return 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan((f / 7500) * (f / 7500)); }

  // Terhardt outer/middle-ear transfer function, f in kHz, returns a dB gain/attenuation. Confirmed
  // exactly against an independent academic source (Terhardt 1979, as cited in cochlear-modeling
  // literature): A(f) = -3.64*f^-0.8 + 6.5*exp(-0.6*(f-3.3)^2) - 0.001*f^4
  function terhardtDb(fHz) {
    const f = fHz / 1000;
    return -3.64 * Math.pow(f, -0.8) + 6.5 * Math.exp(-0.6 * (f - 3.3) * (f - 3.3)) - 0.001 * f * f * f * f;
  }

  // Schroeder spreading function (Schroeder et al. 1979) — how much a masker at Bark position j spreads
  // into a band at Bark position i, as a LINEAR power ratio. Confirmed against two independent sources
  // (both citing the same underlying formula with identical constants).
  function schroederSpreadDb(dz) { // dz = j - i (masker bark minus target bark)
    const tmpx = 1.05 * dz;
    const x = 8 * Math.min((tmpx - 0.5) * (tmpx - 0.5) - 2 * (tmpx - 0.5), 0);
    const tmpy = 15.811389 + 7.5 * (tmpx + 0.474) - 17.5 * Math.sqrt(1 + (tmpx + 0.474) * (tmpx + 0.474));
    return tmpy < -100 ? -Infinity : x + tmpy; // dB; caller converts to linear
  }

  const ZWICKER_FFT_SIZE = 4096; // finer frequency resolution than the main STFT pass — needed to
                                  // resolve the lowest Bark bands (which are narrow in Hz) meaningfully
  const ZWICKER_HOP = 1024;
  const ZWICKER_HANN = (() => { const n = ZWICKER_FFT_SIZE, w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); return w; })();
  const zwRe = new Float64Array(ZWICKER_FFT_SIZE), zwIm = new Float64Array(ZWICKER_FFT_SIZE);

  // Precomputed once per sample rate: which FFT bins fall in which Bark band, the spreading matrix
  // between bands, and each band's threshold-in-quiet excitation — none of this depends on the signal,
  // only on sampleRate, so it's cached rather than rebuilt per track.
  const _zwickerTablesCache = new Map();
  function zwickerTablesFor(sampleRate) {
    if (_zwickerTablesCache.has(sampleRate)) return _zwickerTablesCache.get(sampleRate);
    const half = ZWICKER_FFT_SIZE >> 1;
    const binToBark = new Float64Array(half);
    const binToDb = new Float64Array(half); // Terhardt weighting per bin, precomputed
    for (let k = 1; k < half; k++) {
      const f = k * sampleRate / ZWICKER_FFT_SIZE;
      binToBark[k] = hzToBark(f);
      binToDb[k] = terhardtDb(Math.max(20, f));
    }
    // Bark band centers at 0.5, 1.5, ..., 23.5 (24 bands covering 0-24 Bark)
    const bandCenters = new Float64Array(ZWICKER_NUM_BANDS);
    for (let b = 0; b < ZWICKER_NUM_BANDS; b++) bandCenters[b] = b + 0.5;

    // Spreading matrix: spread[i][j] = linear gain from masker band j into target band i
    const spread = [];
    for (let i = 0; i < ZWICKER_NUM_BANDS; i++) {
      const row = new Float64Array(ZWICKER_NUM_BANDS);
      for (let j = 0; j < ZWICKER_NUM_BANDS; j++) {
        const dB = schroederSpreadDb(bandCenters[j] - bandCenters[i]);
        row[j] = dB === -Infinity ? 0 : Math.pow(10, dB / 10);
      }
      spread.push(row);
    }

    // Threshold-in-quiet excitation per band: the excitation level (linear) corresponding to 0dB
    // "effective" SPL at that band's center frequency after outer/middle-ear weighting — i.e. the
    // quietest signal that would still register, used as the floor in the specific-loudness transform.
    const bandFreqHz = bandCenters.map(z => {
      // Invert hzToBark via bisection — no closed-form inverse for this particular Bark formula.
      let lo = 20, hi = 20000;
      for (let iter = 0; iter < 40; iter++) { const mid = (lo + hi) / 2; if (hzToBark(mid) < z) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    });
    const tqExcitation = new Float64Array(ZWICKER_NUM_BANDS);
    for (let b = 0; b < ZWICKER_NUM_BANDS; b++) tqExcitation[b] = Math.pow(10, -terhardtDb(bandFreqHz[b]) / 10);

    const tables = { binToBark, binToDb, spread, tqExcitation };
    _zwickerTablesCache.set(sampleRate, tables);
    return tables;
  }

  // Specific-loudness scaling constant — see the header comment above for why this is calibrated rather
  // than taken from a disputed textbook value. Computed once, lazily, the first time it's needed.
  let _zwickerN0 = null;
  function zwickerN0() {
    if (_zwickerN0 !== null) return _zwickerN0;
    // A 1kHz tone at 40dB SPL must integrate to 1.0 Sone total loudness, by definition of the Sone
    // scale. Solve for the one scaling constant that makes that true, using this same pipeline.
    const sr = 44100, dur = 1, n = sr * dur;
    const amplitudeFor40dB = Math.pow(10, (40 - ZWICKER_FS_SPL_DB) / 20); // relative to full-scale = 100dB
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = amplitudeFor40dB * Math.sin(2 * Math.PI * 1000 * i / sr);
    const rawSeq = zwickerLoudnessRaw(tone, sr); // total loudness PER FRAME with N0=1 (unscaled) — an
                                                  // array, not a scalar; averaging it was missing entirely
                                                  // before, so `rawSeq > 0` silently coerced to NaN > 0
                                                  // (always false) and calibration always fell back to a
                                                  // placeholder of 1 instead of ever actually calibrating.
    const raw = rawSeq.length ? rawSeq.reduce((a, b) => a + b, 0) / rawSeq.length : 0;
    _zwickerN0 = raw > 0 ? 1 / raw : 1;
    return _zwickerN0;
  }

  // Computes total loudness N(t) at each analysis frame, UNSCALED (as if N0=1) — zwickerN0() uses this
  // directly to self-calibrate; computeM03 multiplies by the calibrated constant afterward.
  function zwickerLoudnessRaw(samples, sampleRate, n0 = 1) {
    const { binToBark, binToDb, spread, tqExcitation } = zwickerTablesFor(sampleRate);
    const N = ZWICKER_FFT_SIZE, H = ZWICKER_HOP, total = samples.length, half = N >> 1;
    if (total < N) return [];
    const frameCount = Math.floor((total - N) / H) + 1;
    const loudnessSeq = new Float64Array(frameCount);
    const bandExcitation = new Float64Array(ZWICKER_NUM_BANDS);
    const spreadExcitation = new Float64Array(ZWICKER_NUM_BANDS);

    for (let m = 0; m < frameCount; m++) {
      const off = m * H;
      for (let i = 0; i < N; i++) zwRe[i] = samples[off + i] * ZWICKER_HANN[i];
      zwIm.fill(0);
      fftInPlace(zwRe, zwIm);

      bandExcitation.fill(0);
      for (let k = 1; k < half; k++) {
        const power = zwRe[k] * zwRe[k] + zwIm[k] * zwIm[k];
        if (power <= 0) continue;
        // Convert to dB, apply outer/middle-ear weighting, back to linear "excitation" units, accumulate
        // into whichever Bark band this bin falls in. +ZWICKER_FS_SPL_DB converts from dBFS (0dB =
        // digital full-scale amplitude, what 10*log10(power) alone gives) to the absolute SPL reference
        // tqExcitation is expressed in — without it, this compares two values on different scales, which
        // silently made every realistic-amplitude signal read as entirely below threshold (verified
        // directly: a 40dB 1kHz reference tone was computing exactly 0 Sone instead of the expected ~1.0
        // before this fix).
        const dB = 10 * Math.log10(power) + ZWICKER_FS_SPL_DB + binToDb[k];
        const excitation = Math.pow(10, dB / 10);
        const band = Math.min(ZWICKER_NUM_BANDS - 1, Math.max(0, Math.floor(binToBark[k])));
        bandExcitation[band] += excitation;
      }

      // Spread each band's excitation across all bands via the precomputed spreading matrix.
      for (let i = 0; i < ZWICKER_NUM_BANDS; i++) {
        let acc = 0;
        for (let j = 0; j < ZWICKER_NUM_BANDS; j++) acc += bandExcitation[j] * spread[i][j];
        spreadExcitation[i] = acc;
      }

      // Specific loudness per band (simplified Zwicker power law, s(z)=1 — see header comment), summed
      // across bands for this frame's total loudness.
      let totalN = 0;
      for (let b = 0; b < ZWICKER_NUM_BANDS; b++) {
        const E = spreadExcitation[b], ETQ = tqExcitation[b];
        if (E > ETQ) totalN += n0 * Math.pow(ETQ, -0.23) * (Math.pow(E / ETQ, 0.23) - 1) * Math.pow(ETQ, 0.23);
        // equivalent to n0 * [(E/ETQ)^0.23 - 1], written this way to avoid E/ETQ overflowing for very
        // loud/quiet outlier bands before the subtraction
      }
      loudnessSeq[m] = totalN;
    }
    return loudnessSeq;
  }

  function computeM03(samples, sampleRate) {
    const n0 = zwickerN0();
    const loudnessSeq = zwickerLoudnessRaw(samples, sampleRate, n0);
    if (!loudnessSeq.length || loudnessSeq.length < 2) return 0;
    const dt = ZWICKER_HOP / sampleRate;
    const derivSeq = new Float64Array(loudnessSeq.length);
    for (let m = 1; m < loudnessSeq.length; m++) derivSeq[m] = Math.max(0, loudnessSeq[m] - loudnessSeq[m - 1]); // growth only — a sudden drop in loudness isn't "explosive"

    // Same threshold-gated peak-picking pattern as M01/M07/M06, for the same reason verified there.
    const positive = []; for (let i = 0; i < derivSeq.length; i++) if (derivSeq[i] > 0) positive.push(derivSeq[i]);
    if (!positive.length) return 0;
    const sorted = Float64Array.from(positive).sort();
    const med = percentile(sorted, 0.5, true);
    let madSum = 0; for (let i = 0; i < sorted.length; i++) madSum += Math.abs(sorted[i] - med);
    const thresh = med + 2.0 * (madSum / sorted.length);
    const peaks = [];
    for (let m = 1; m < derivSeq.length - 1; m++) {
      if (derivSeq[m] > thresh && derivSeq[m] >= derivSeq[m - 1] && derivSeq[m] >= derivSeq[m + 1]) peaks.push(derivSeq[m] / dt);
    }
    return peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : 0;
  }

  // M09: peak-to-RMS ratio in very short (10ms) non-overlapping windows — separate from the main STFT
  // pass entirely, since this needs much finer time resolution than a 46ms analysis frame. Deliberately
  // kept low-weighted in the final composite so the overall score doesn't just track how hard a track
  // was mastered/limited.
  const MICRO_WIN_MS = 10;
  function computeM09(samples, sampleRate) {
    const winSize = Math.max(8, Math.round(sampleRate * MICRO_WIN_MS / 1000));
    const total = samples.length;
    if (total < winSize) return 0;
    const vals = [];
    for (let off = 0; off + winSize <= total; off += winSize) {
      let sumSq = 0, peak = 0;
      for (let i = 0; i < winSize; i++) {
        const s = samples[off + i], a = Math.abs(s);
        sumSq += s * s; if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sumSq / winSize);
      if (rms < 1e-6) continue; // silent micro-window — not meaningful for a peak/RMS ratio
      vals.push(20 * Math.log10(peak / rms));
    }
    // 90th percentile — "how prominent are the sharpest micro-peaks a track actually preserves",
    // without letting one single-sample spike (which could be a decode artifact, not real content) set
    // the whole result the way a literal max would.
    return vals.length ? percentile(vals, 0.90) : 0;
  }

  // Explosiveness metrics: decode -> shared STFT pass (M01/M02/M05/M07) + TSER's own pass + wavelet pass +
  // Zwicker pass + M09's short-window pass -> the 9 raw values, nothing more. There is DELIBERATELY no
  // composite score computed here anymore. An earlier version of this function also did min-max normalize
  // -> weighted sum -> sigmoid to produce a single 0-100 "Explosiveness" value, using bounds that turned
  // out — once tested against realistic (not just synthetic-extreme) signals — to be badly miscalibrated:
  // a deliberately calm, ambient-style test track scored 25, nowhere near the intended floor, because a
  // couple of the nine metrics (centroid velocity especially) saturate on ordinary noise-floor content
  // present in essentially all real audio, not just genuinely explosive moments. Fixed bounds guessed in
  // isolation can't self-correct for that. The composite is now computed CLIENT-SIDE instead (in
  // player.js), ranked against whatever tracks are actually visible at the time — percentile position
  // within real, current data, not a fixed scale that can silently be wrong for an entire class of audio.
  // That also means the composite is never stored or synced — only these 9 raw values are; see
  // energy-codec.js's v8 section and storeEnergy()/analyzeEnergy() in player.js for how they're persisted
  // and kept in sync across devices, and computeExplosivenessScores() in player.js for the ranking itself.
  // Several of the metrics below do their own separate pass over `samples` rather than reusing the shared
  // STFT frames — a known, accepted inefficiency (each needs different framing: TSER's sliding ring
  // buffer, the wavelet transform's scale-dependent kernels, Zwicker's finer FFT resolution and Bark-band
  // structure, M09's much finer time resolution), not a correctness concern. M03 (Zwicker) is by far the
  // most expensive of the nine — roughly 3.5 seconds alone on a 4.5-minute track in testing, more than
  // double every other metric combined — worth knowing since it materially affects total per-track
  // analysis time.
  // Stage boundaries below are weighted by REAL measured cost, not an even 1/9th each — profiled directly
  // on a 20-minute track: the shared STFT pass is ~10% of total time, M03 ~17%, M04 (TSER) a dominant
  // ~71% on its own (even after the two optimizations that made this function fast enough to profile in
  // the first place — see medianOf's own header comment), everything else combined under 2%. An evenly-
  // spaced "stage 4 of 7" indicator would sit at M04 for the vast majority of a track's analysis time and
  // look stuck even while genuinely progressing — these weights are what let a progress bar actually move
  // smoothly and honestly instead. onProgress is optional and entirely for reporting; passing none costs
  // nothing extra and changes no computed value.
  function computeExplosivenessMetrics(samples, sampleRate, bpm, onProgress) {
    const report = onProgress || (() => {});
    const frames = explosivenessFrames(samples, sampleRate);
    if (!frames) return null; // too short to analyze meaningfully
    report(0.10);
    const { m01, m02, m05, m07 } = computeM01_M02_M05_M07(frames, bpm);
    report(0.10); // negligible cost, no meaningful jump expected here
    const m03 = computeM03(samples, sampleRate);
    report(0.27);
    const m04 = computeTSER(samples, sampleRate, p => report(0.27 + p * 0.71)); // the dominant stage — see its own internal reporting
    report(0.98);
    const m06 = computeWaveletGradient(samples, sampleRate);
    report(0.985);
    const m08 = computeM08(frames);
    const m09 = computeM09(samples, sampleRate);
    report(1);
    return { m01, m02, m03, m04, m05, m06, m07, m08, m09 };
  }

  return { computeEnergyProfile, computeSubBass, explosivenessFrames, computeM01_M02_M05_M07, computeM08, computeM09, computeTSER, computeWaveletGradient, computeM03, zwickerLoudnessRaw, zwickerN0, computeExplosivenessMetrics, percentile, EXPLO_SILENCE_GATE };
});
