// Uzikext's waveform views, shared by the single player and the app's two decks.
//
// A track can be shown three ways:
//   'art'      the animated design (track-art.js; drawn by the page that uses this file)
//   'analysis' the analysed energy: intensity above, bass below (the page's paintEnergy)
//   'audio'    the audio waveform: the drums to the ms, laid out and coloured like 'analysis' (drawn here)
// The panel is one view over the whole track, or split: a scrolling view of the music around the playhead
// on top (2/3 of the height, ± `zoom` seconds, with the beat grid), the whole track below (1/3).
// One setting for every player ('waveView' in storage): { split, main, top, zoom }, where `main` is the
// whole-track view (the only one when not split, the bottom one when split) and `top` the scrolling one.
//
// Buttons at the panel's right edge (createBar) switch all this; they show when the mouse is over it.
//
// Waveform data ("peaks", v2): 150 frames per second of track, 4 bytes each: the overall peak, then the
// loudness (RMS) of the bass (< 200 Hz), mids and highs (> 2 kHz), each scaled to its own level in the
// track (see computePeaks). The app's engine computes the same thing in Rust (dvs.rs: track_peaks).
(function (root) {
  'use strict';
  const RATE = 150;
  const TYPES = ['art', 'analysis', 'audio'];
  const ZOOM_MIN = 1, ZOOM_MAX = 30;

  // ---------- computing the waveform data ----------
  // RBJ biquad (Q = 1/√2: Butterworth), as [b0, b1, b2, a1, a2]
  function biquad(kind, f0, sr) {
    const w = 2 * Math.PI * f0 / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
    const b = kind === 'lp' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    const a0 = 1 + al;
    return [b[0] / a0, b[1] / a0, b[2] / a0, (-2 * cw) / a0, (1 - al) / a0];
  }

  // channels: Float32Arrays (1 or 2) at `sr`. opts.yieldEvery: frames between awaits of opts.yieldFn
  // (keeps the page responsive). -> { v: 2, rate, n, data: Uint8Array(4n) }
  // Per frame: the overall peak (scaled to the track's loudest), then the loudness (RMS) of the bass, mids
  // and highs, each scaled to its own level in the track (its 99.5th percentile = 255). RMS, not peaks: a
  // loud master hits its peak ceiling almost everywhere, but the energy of each band still rises and falls
  // with the kicks, the claps and the hats. The bass's loudness is taken over 3 frames (20 ms: a full cycle
  // of a 50 Hz bass).
  async function computePeaks(channels, sr, opts = {}) {
    const L = channels[0], R = channels[1] || channels[0];
    const len = L.length, n = Math.max(1, Math.floor(len * RATE / sr));
    const pkA = new Float32Array(n), sl = new Float64Array(n), sm = new Float64Array(n), sh = new Float64Array(n), cnt = new Float64Array(n);
    const [lb0, lb1, lb2, la1, la2] = biquad('lp', 200, sr), [hb0, hb1, hb2, ha1, ha2] = biquad('hp', 2000, sr);
    // the mids: 200 Hz - 2 kHz (a low-pass at 2 kHz, then a high-pass at 200 Hz)
    const [mb0, mb1, mb2, ma1, ma2] = biquad('lp', 2000, sr), [nb0, nb1, nb2, na1, na2] = biquad('hp', 200, sr);
    let lx1 = 0, lx2 = 0, ly1 = 0, ly2 = 0, hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0, top = 0, i = 0;
    let mx1 = 0, mx2 = 0, my1 = 0, my2 = 0, nx1 = 0, nx2 = 0, ny1 = 0, ny2 = 0;
    const spf = sr / RATE, every = opts.yieldEvery || 0;
    for (let f = 0; f < n; f++) {
      const end = Math.min(len, Math.floor((f + 1) * spf));
      let p = 0, a = 0, m = 0, h = 0, c = 0;
      for (; i < end; i++) {
        const x = (L[i] + R[i]) * 0.5;
        const yl = lb0 * x + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2;
        lx2 = lx1; lx1 = x; ly2 = ly1; ly1 = yl;
        const yh = hb0 * x + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
        hx2 = hx1; hx1 = x; hy2 = hy1; hy1 = yh;
        const ym0 = mb0 * x + mb1 * mx1 + mb2 * mx2 - ma1 * my1 - ma2 * my2;
        mx2 = mx1; mx1 = x; my2 = my1; my1 = ym0;
        const ym = nb0 * ym0 + nb1 * nx1 + nb2 * nx2 - na1 * ny1 - na2 * ny2;
        nx2 = nx1; nx1 = ym0; ny2 = ny1; ny1 = ym;
        const ax = x < 0 ? -x : x;
        if (ax > p) p = ax;
        a += yl * yl; m += ym * ym; h += yh * yh; c++;
      }
      pkA[f] = p; sl[f] = a; sm[f] = m; sh[f] = h; cnt[f] = c;
      if (p > top) top = p;
      if (every && opts.yieldFn && f % every === every - 1) await opts.yieldFn();
    }
    const lo = new Float32Array(n), mi = new Float32Array(n), hi = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const f0 = f > 0 ? f - 1 : f, f1 = f < n - 1 ? f + 1 : f;
      let s3 = 0, c3 = 0;
      for (let g = f0; g <= f1; g++) { s3 += sl[g]; c3 += cnt[g]; }
      lo[f] = c3 ? Math.sqrt(s3 / c3) : 0;
      mi[f] = cnt[f] ? Math.sqrt(sm[f] / cnt[f]) : 0;
      hi[f] = cnt[f] ? Math.sqrt(sh[f] / cnt[f]) : 0;
    }
    const ref = arr => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(s.length * 0.995))] || 0; };
    const q = (v, r) => r > 0 ? Math.min(255, Math.round(v / r * 255)) : 0;
    const rl = ref(lo), rm = ref(mi), rh = ref(hi);
    const data = new Uint8Array(4 * n);
    for (let f = 0; f < n; f++) {
      data[4 * f] = q(pkA[f], top); data[4 * f + 1] = q(lo[f], rl); data[4 * f + 2] = q(mi[f], rm); data[4 * f + 3] = q(hi[f], rh);
    }
    return { v: 2, rate: RATE, n, data };
  }

  // the engine's bytes (dvs_peaks) -> the same object
  function peaksFromBytes(buf) {
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return { v: 2, rate: RATE, n: Math.floor(data.length / 4), data };
  }

  // ---------- the hits: what the audio waveform draws ----------
  // The drums, to the millisecond: 1000 frames per second, 3 bytes each:
  //   the low end's attacks (35-130 Hz: kicks, bass notes), drawn downwards;
  //   the attacks of the mids and highs (150-400 Hz, the body of a snare or clap, and 1.8-7 kHz, its noise,
  //     the hats, a kick's click), drawn upwards;
  //   the bass's level (< 180 Hz, over 25 ms), drawn faintly behind the kicks.
  // (as the analysed energy: mids and highs above, the low end below)
  // An attack is how far the level over the last few ms (6 ms for the low end, 3 and 2 for the others) rises
  // above the level just before it (the 80 / 60 / 50 ms up to 2 ms earlier, × 1.15): a hit shows, a held
  // note or a swelling bass doesn't. Each hit is then held and let go over 45 ms (low) / 35 ms (others), so
  // it has a body you can see; its front stays at the attack. Filtered both ways (no delay): the front is
  // where the hit is, to the millisecond. Each row is scaled to the track's loudest hits (99.7th
  // percentile; the bass: 99th). The engine computes the same (dvs.rs: track_hits).
  const HIT_RATE = 1000;
  const HIT_BANDS = [   // [high-pass, low-pass] (each twice: 4th order), Hz
    [35, 130], [150, 400], [1800, 7000], [0, 180]
  ];
  const HIT_CHUNK = 10000, HIT_MARGIN = 0.5;   // filtered in 10 s chunks (+ 0.5 s each side, to settle)
  async function computeHits(channels, sr, opts = {}) {
    const L = channels[0], R = channels[1] || channels[0];
    const len = L.length, n = Math.max(1, Math.floor(len * HIT_RATE / sr));
    const start = f => Math.min(len, Math.floor(f * sr / HIT_RATE));
    const secs = HIT_BANDS.map(([hp, lp]) => {
      const s = [];
      if (hp > 0) { const c = biquad('hp', Math.min(hp, 0.45 * sr), sr); s.push(c, c); }
      const c = biquad('lp', Math.min(lp, 0.45 * sr), sr); s.push(c, c);
      return s;
    });
    const E = HIT_BANDS.map(() => new Float32Array(n));
    const M = Math.round(HIT_MARGIN * sr);
    let buf = null, mono = null;
    for (let c0 = 0; c0 < n; c0 += HIT_CHUNK) {
      const c1 = Math.min(n, c0 + HIT_CHUNK), s0 = start(c0), s1 = start(c1);
      const p0 = Math.max(0, s0 - M), p1 = Math.min(len, s1 + M), m = p1 - p0;
      if (!mono || mono.length < m) { mono = new Float64Array(m); buf = new Float64Array(m); }
      for (let i = 0; i < m; i++) mono[i] = (L[p0 + i] + R[p0 + i]) * 0.5;
      for (let b = 0; b < HIT_BANDS.length; b++) {
        for (let i = 0; i < m; i++) buf[i] = mono[i];
        for (let dir = 0; dir < 2; dir++) {
          for (const [b0, b1, b2, a1, a2] of secs[b]) {
            let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
            if (dir === 0) {
              for (let i = 0; i < m; i++) { const x = buf[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y; }
            } else {
              for (let i = m - 1; i >= 0; i--) { const x = buf[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y; }
            }
          }
        }
        const e = E[b];
        for (let f = c0; f < c1; f++) {
          let s = 0;
          for (let i = start(f) - p0, j = start(f + 1) - p0; i < j; i++) s += buf[i] * buf[i];
          e[f] = s;
        }
      }
      if (opts.yieldFn) await opts.yieldFn();
    }
    // the level (RMS) over the frames lo..hi
    const level = (e, lo, hi) => {
      if (lo < 0) lo = 0;
      if (hi > n - 1) hi = n - 1;
      if (hi < lo) return 0;
      let s = 0;
      for (let f = lo; f <= hi; f++) s += e[f];
      const c = start(hi + 1) - start(lo);
      return c > 0 ? Math.sqrt(s / c) : 0;
    };
    const attack = (e, f, fast, slow) => {
      const lo = f - Math.floor((fast - 1) / 2);
      const v = level(e, lo, lo + fast - 1) - 1.15 * level(e, f - 2 - slow, f - 3);
      return v > 0 ? v : 0;
    };
    const K = new Float32Array(n), S = new Float32Array(n), B = new Float32Array(n);
    const gk = Math.exp(-1 / 45), gs = Math.exp(-1 / 35);
    let ak = 0, as = 0;
    for (let f = 0; f < n; f++) {
      const k = attack(E[0], f, 6, 80), s = attack(E[1], f, 3, 60) + 0.8 * attack(E[2], f, 2, 50);
      ak = Math.max(k, ak * gk); as = Math.max(s, as * gs);
      K[f] = ak; S[f] = as; B[f] = level(E[3], f - 12, f + 12);
      if (opts.yieldFn && f % 60000 === 59999) await opts.yieldFn();
    }
    const ref = (arr, p) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
    const q = (v, r) => r > 0 ? Math.min(255, Math.round(v / r * 255)) : 0;
    const rk = ref(K, 0.997), rs = ref(S, 0.997), rb = ref(B, 0.99);
    const data = new Uint8Array(3 * n);
    for (let f = 0; f < n; f++) { data[3 * f] = q(K[f], rk); data[3 * f + 1] = q(S[f], rs); data[3 * f + 2] = q(B[f], rb); }
    return { v: 1, rate: HIT_RATE, n, data };
  }
  function hitsFromBytes(buf) {
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return { v: 1, rate: HIT_RATE, n: Math.floor(data.length / 3), data };
  }

  // ---------- the beat grid ----------
  // From the track's BPM and its transients: the exact tempo near the BPM (±0.6, to 0.002) and where the
  // beats fall, where the attacks line up best. The attacks are the rises of the mids and of the overall
  // peak (a kick's click, a clap): NOT the bass, whose level in most dance music swells between the kicks
  // (a rolling or offbeat bassline, sidechained under the kick) and would put the grid off the beat (by
  // 40-80 ms on a typical techno track, or on the offbeat). Bars (4 beats) count from the first strong beat,
  // where the music starts. Constant-tempo music only; null without a BPM.
  const gridCache = new Map();
  function beatGrid(pk, bpm, key, v = 1) {
    if (!pk || !bpm || !(bpm > 40 && bpm < 250)) return null;
    const ck = (key || '') + '|' + pk.n + '|' + bpm + '|' + v;
    if (gridCache.has(ck)) return gridCache.get(ck);
    const n = pk.n, d = pk.data;
    // attacks: how much the mids and the peak rose since the frame before
    const on = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const rm = d[4 * i + 2] - d[4 * i - 2], rp = d[4 * i] - d[4 * i - 4];
      on[i] = (rm > 0 ? rm : 0) + (rp > 0 ? rp : 0);
    }
    const BINS = 128;
    const hist = new Float32Array(BINS);
    let best = null;
    const fold = b => {
      const P = 60 / b * RATE;
      hist.fill(0);
      for (let i = 0; i < n; i++) { if (!on[i]) continue; const ph = (i % P) / P * BINS; hist[ph | 0] += on[i]; }
      let bi = 0, bs = -1;
      const sm = j => hist[(j + BINS - 1) % BINS] + 2 * hist[j] + hist[(j + 1) % BINS];
      for (let j = 0; j < BINS; j++) { const v = sm(j); if (v > bs) { bs = v; bi = j; } }
      // between bins: the top of a parabola through the best one and its neighbours
      const y0 = sm((bi + BINS - 1) % BINS), y2 = sm((bi + 1) % BINS), den = y0 - 2 * bs + y2;
      const off = den < 0 ? 0.5 * (y0 - y2) / den : 0;
      return { b, P, score: bs, phase: (bi + 0.5 + off) / BINS * P };
    };
    for (let b = bpm - 0.6; b <= bpm + 0.6001; b += 0.02) { const r = fold(b); if (!best || r.score > best.score) best = r; }
    for (let b = best.b - 0.02; b <= best.b + 0.0201; b += 0.002) { const r = fold(b); if (r.score > best.score) best = r; }
    // Which of the attacks are the beats, and which beat starts the bar. The strongest attacks can be the
    // offbeat hats, or a breakbeat's syncopations (jungle, drum & bass), so the music is laid on a grid of
    // 16ths from there, folded over one bar, and compared with what a bar of dance music is made of: kicks
    // on 1 and 3 (and often 2 and 4), snares or claps on 2 and 4, not on 1 and 3. A kick is the bass rising
    // over the 33 ms after an attack (not the bass's level: a sidechained bass swells between the kicks);
    // a snare, the mids and highs rising. Only the 16ths that carry the main attacks (70 % of the strongest)
    // can be beats.
    let shift = 0, ambiguousBar = true;
    {
      const P0 = best.P, S = P0 / 4;
      const K = new Float64Array(16), N = new Float64Array(16), C = new Float64Array(16);
      const lo = j => d[4 * Math.max(0, Math.min(n - 1, j)) + 1];
      const rise = (j, o) => Math.max(0, d[4 * j + o] - d[4 * (j - 1) + o]);
      for (let k = 0, f = best.phase; f < n - 7; k++, f = best.phase + k * S) {
        const i = Math.round(f), st = k % 16;
        if (i < 2) continue;
        let kk = 0, sn = 0;
        for (let j = i - 1; j <= i + 1; j++) {
          kk = Math.max(kk, lo(j + 5) - lo(j - 1));
          sn = Math.max(sn, rise(j, 2) + 0.5 * rise(j, 3));
        }
        K[st] += kk; N[st] += sn; C[st]++;
      }
      let mk = 0, mn = 0;
      for (let st = 0; st < 16; st++) { K[st] /= C[st] || 1; N[st] /= C[st] || 1; mk = Math.max(mk, K[st]); mn = Math.max(mn, N[st]); }
      for (let st = 0; st < 16; st++) { K[st] /= mk || 1; N[st] /= mn || 1; }
      const q = [0, 1, 2, 3].map(r => (N[r] + N[r + 4] + N[r + 8] + N[r + 12]) / 4), qmax = Math.max(...q);
      const TK = { 0: 1, 8: 1, 4: 0.5, 12: 0.5, 2: 0.15, 10: 0.15 }, TS = { 4: 1, 12: 1, 0: -0.5, 8: -0.5 };
      const score = r => {
        let v = 0;
        for (const st in TK) v += TK[st] * K[(+st + r) % 16];
        for (const st in TS) v += TS[st] * N[(+st + r) % 16];
        return v;
      };
      let bs = -Infinity;
      for (let r = 0; r < 16; r++) if (q[r % 4] >= 0.7 * qmax) { const v = score(r); if (v > bs) { bs = v; shift = r; } }
      // the bar: clear when one of the 4 beats scores clearly best
      // (v2: only beats 2 and 4 against the 1: the pattern can't tell 1 from 3 in four-to-the-floor anyway, the
      // changes do, between those two)
      ambiguousBar = (v >= 2 ? [4, 12] : [4, 8, 12]).some(o => bs - score((shift + o) % 16) < 0.03 * Math.abs(bs));
      best.phase += (shift % 4) * S;
    }
    // Then exactly: each beat's own attack (the strongest rise within ±4 frames of where the grid puts it,
    // between frames by a parabola), and the straight line through all of them (least squares, then again
    // without the ones more than 8 ms off): the tempo to about 0.0005 BPM, the grid within a few ms from
    // the first beat to the last.
    let P = best.P, ph = best.phase;
    for (let pass = 0; pass < 2; pass++) {
      const ks = [], ts = [];
      let maxOn = 0;
      for (let i = 0; i < n; i++) if (on[i] > maxOn) maxOn = on[i];
      for (let k = 0, f = ph; f < n - 1; k++, f = ph + k * P) {
        const c = Math.round(f);
        let bj = -1, bv = maxOn * 0.15;
        for (let j = Math.max(1, c - 4); j <= Math.min(n - 2, c + 4); j++) if (on[j] > bv) { bv = on[j]; bj = j; }
        if (bj < 0) continue;
        const y0 = on[bj - 1], y2 = on[bj + 1], den = y0 - 2 * bv + y2;
        ks.push(k); ts.push(bj + (den < 0 ? 0.5 * (y0 - y2) / den : 0));
      }
      if (ks.length < 16) break;
      const fit = (use) => {
        let sk = 0, st = 0, skk = 0, skt = 0, m = 0;
        for (let i = 0; i < ks.length; i++) if (use[i]) { sk += ks[i]; st += ts[i]; skk += ks[i] * ks[i]; skt += ks[i] * ts[i]; m++; }
        const slope = (m * skt - sk * st) / (m * skk - sk * sk);
        return { slope, icpt: (st - slope * sk) / m };
      };
      let use = ks.map(() => true), r = fit(use);
      use = ks.map((k, i) => Math.abs(ts[i] - (r.icpt + r.slope * k)) < 0.008 * RATE);
      if (use.filter(Boolean).length >= 16) r = fit(use);
      if (!(r.slope > 0) || Math.abs(r.slope / P - 1) > 0.01) break;
      P = r.slope; ph = r.icpt;
    }
    // (+ half a frame: a rise in frame i happened, on average, in the middle of it)
    const period = P / RATE, t0 = (((ph % P) + P) % P + 0.5) / RATE;
    const down = ((((ph + Math.floor(shift / 4) * P) % (4 * P)) + 4 * P) % (4 * P) + 0.5) / RATE;   // a downbeat
    // the first strong beat: the bass of a beat reaching 30 % of the track's strongest
    let maxLo = 0;
    for (let i = 0; i < n; i++) if (d[4 * i + 1] > maxLo) maxLo = d[4 * i + 1];
    let first = t0;
    for (let t = t0; t < n / RATE; t += period) {
      const f = Math.round(t * RATE);
      let v = 0;
      for (let j = Math.max(0, f - 3); j <= Math.min(n - 1, f + 3); j++) v = Math.max(v, d[4 * j + 1]);
      if (v >= maxLo * 0.3) { first = t; break; }
    }
    // Which beat is the 1. The pattern tells the kick beats (1 and 3) from the snare beats (2 and 4), not 1
    // from 3; the structure does: dance music is built in phrases of 8, 16, 32 bars, and where it changes
    // (the drop, the bass coming in, a breakdown, new sounds) is a 1. So each beat gets how much the music
    // changes there (the bass, mids and highs over the bar after it against the bar before), the clear
    // changes vote for their beat of the bar, and the most voted of the candidates is the 1: the
    // pattern's two (its 1 and 3), or all four when the pattern can't tell them apart. Without a clear
    // vote (few changes, or as many on two beats): the pattern's 1, or the first strong beat.
    const nbt = Math.floor((n / RATE - t0) / period);
    const F = [];
    for (let k = 0; k < nbt; k++) {
      const a = Math.floor((t0 + k * period) * RATE), b = Math.min(n, Math.floor((t0 + (k + 1) * period) * RATE));
      let s1 = 0, s2 = 0, s3 = 0;
      for (let i = a; i < b; i++) { s1 += d[4 * i + 1]; s2 += d[4 * i + 2]; s3 += d[4 * i + 3]; }
      const c = Math.max(1, b - a);
      F.push([s1 / c, s2 / c, s3 / c]);
    }
    const nov = new Float64Array(F.length);
    for (let k = 4; k < F.length - 4; k++) {
      let v = 0;
      for (let band = 0; band < 3; band++) {
        let be = 0, af = 0;
        for (let j = 1; j <= 4; j++) { be += F[k - j][band]; af += F[k + j - 1][band]; }
        be /= 4; af /= 4;
        v += Math.abs(af - be) / (af + be + 8);
      }
      nov[k] = v;
    }
    const sorted = Array.from(nov.slice(4, Math.max(4, nov.length - 4))).sort((x, y) => x - y);
    const med = sorted.length ? sorted[sorted.length >> 1] : 0;
    const mad = sorted.length ? sorted.map(v => Math.abs(v - med)).sort((x, y) => x - y)[sorted.length >> 1] : 0;
    const votes = [0, 0, 0, 0];
    let nPeaks = 0;
    for (let k = 4; k < nov.length - 4; k++) {
      if (nov[k] < med + 2 * mad || nov[k] <= 0) continue;
      let top = true;
      for (let j = k - 4; j <= k + 4; j++) if (j !== k && nov[j] > nov[k]) { top = false; break; }
      if (top) { votes[k % 4] += nov[k]; nPeaks++; }
    }
    const beatOf = t => ((Math.round((t - t0) / period) % 4) + 4) % 4;
    const cands = ambiguousBar ? [0, 1, 2, 3] : [beatOf(down), (beatOf(down) + 2) % 4];
    const ranked = cands.slice().sort((x, y) => votes[y] - votes[x]);
    let bar0 = first, barBy = 'first';
    if (!ambiguousBar) { bar0 = down + Math.ceil((first - down) / (4 * period) - 1e-6) * 4 * period; barBy = 'pattern'; }
    const voted = nPeaks >= 3 && votes[ranked[0]] > 0 && votes[ranked[0]] >= 1.3 * votes[ranked[1]];
    if (voted) {
      const kb = ranked[0];   // the 1: beats kb, kb + 4, …
      const k1 = Math.ceil((first - t0) / period - 1e-6), k = k1 + (((kb - k1) % 4) + 4) % 4;
      bar0 = t0 + k * period; barBy = 'changes';
    }
    // (how sure the bar is: what decided it, and by how much the changes' vote won)
    const g = { bpm: 60 / period, period, t0, bar0, bar: { by: barBy, pattern: !ambiguousBar, vote: votes[ranked[1]] > 0 ? votes[ranked[0]] / votes[ranked[1]] : votes[ranked[0]] > 0 ? 9 : 0, changes: nPeaks } };
    gridCache.set(ck, g);
    if (gridCache.size > 16) gridCache.delete(gridCache.keys().next().value);
    return g;
  }

  // ---------- the exact grid (v2) ----------
  // The grid above, then put exactly on the kicks with the hits (1000 a second): each beat's kick found on the
  // kick row (35-130 Hz, its attack), the same point taken on every kick by one rule, the kick's start: where its
  // attack first reaches KICK_AT of its height (to a tenth of a ms, between frames); that's where the waveform
  // draws its front. Then the straight line through all the kicks of the track (least squares, again without the
  // ones more than 3 ms off, then 2): the tempo and the grid's place from hundreds of kicks, so no one kick (a
  // clap on top, a fill, a sidechain dip) moves it; a long intro without beats is laid from the rest. The bar
  // (which beat is the 1) is the grid's above. How sure it is (conf): the share of the beats with a kick on the
  // line, how far the kicks are from it (rms, ms), and the bar's decision. ok: nothing to check.
  const KICK_AT = 0.5, KICK_WIN = 0.025;
  // (the rows' rise starts a little before the sound does: filtered both ways, over windows centred on each ms;
  // these put the line on the kick's first sample, measured on sharp kicks)
  const ROW_SHIFT = [0.0033, 0.0020];
  // the kick near t (s) on a row (0: the kick row, 35-130 Hz; 1: the mids and highs): its start, or null. One
  // rule on every kick: its first attack (from the low before it up to where the row first falls back: a
  // kick's body, as its pitch falls into the low row, can rise again 20-30 ms later, not its start), and the
  // start where that attack first gets halfway up (between frames).
  function kickStart(hits, t, row, win = KICK_WIN) {
    if (!hits || !hits.data) return null;
    const d = hits.data, n = hits.n, R = HIT_RATE;
    const V = i => d[3 * i + row];
    const c = Math.round(t * R), a = Math.max(1, c - Math.round(win * R)), b = Math.min(n - 1, c + Math.round(win * R));
    let lo = a, M = 0;
    for (let i = a; i <= c; i++) if (V(i) < V(lo)) lo = i;
    for (let i = lo; i <= b; i++) if (V(i) > M) M = V(i);
    const base = V(lo);
    if (M - base < 24) return null;
    // the first attack that gets at least halfway to the window's top (a small rise before it, the filters'
    // ringing ahead of a boomy kick, isn't the kick): from the low just before it to where it first falls back
    let lb = lo, i = lo + 1;
    for (; i <= b; i++) { if (V(i) < V(lb)) lb = i; if (V(i) >= base + 0.5 * (M - base)) break; }
    if (i > b) return null;
    let top = V(i), ti = i;
    for (let j = i + 1; j <= b; j++) { const v = V(j); if (v > top) { top = v; ti = j; } else if (v < top - 4) break; }
    const b0 = V(lb), h = b0 + KICK_AT * (top - b0);
    for (let j = lb + 1; j <= ti; j++) if (V(j) >= h) { const y0 = V(j - 1), y1 = V(j); return (j - 1 + (y1 > y0 ? (h - y0) / (y1 - y0) : 1)) / R + ROW_SHIFT[row]; }
    return null;
  }

  const exactCache = new Map();
  function exactGrid(pk, hits, bpm, key) {
    const g = beatGrid(pk, bpm, key, 2);
    if (!g || !hits || !hits.data || hits.rate !== HIT_RATE) return g;
    const ck = (key || '') + '|' + pk.n + '|' + hits.n + '|' + bpm;
    if (exactCache.has(ck)) return exactCache.get(ck);
    const n = hits.n, R = HIT_RATE;
    const kickAt = (t, row) => kickStart(hits, t, row);
    const P = g.period, k0 = Math.ceil(-g.t0 / P), k1 = Math.floor((n / R - g.t0) / P);
    // the straight line through the kicks found on a row (least squares, then without the ones more than 6, 3,
    // then 2 ms off it)
    const lineOf = row => {
      const ks = [], ts = [];
      for (let k = k0; k <= k1; k++) { const t = kickAt(g.t0 + k * P, row); if (t != null) { ks.push(k); ts.push(t); } }
      const fit = use => {
        let sk = 0, st = 0, skk = 0, skt = 0, m = 0;
        for (let i = 0; i < ks.length; i++) if (use[i]) { sk += ks[i]; st += ts[i]; skk += ks[i] * ks[i]; skt += ks[i] * ts[i]; m++; }
        if (m < 16) return null;
        const slope = (m * skt - sk * st) / (m * skk - sk * sk);
        return { slope, icpt: (st - slope * sk) / m, m };
      };
      let use = ks.map(() => true), r = fit(use);
      for (const lim of [0.006, 0.003, 0.002]) {
        if (!r) break;
        const u = ks.map((k, i) => Math.abs(ts[i] - (r.icpt + r.slope * k)) < lim);
        const r2 = fit(u);
        if (!r2) break;
        use = u; r = r2;
      }
      if (!r || !(r.slope > 0) || Math.abs(r.slope / P - 1) > 0.002) return null;
      let ss = 0;
      for (let i = 0; i < ks.length; i++) if (use[i]) { const e = ts[i] - (r.icpt + r.slope * ks[i]); ss += e * e; }
      // (the kicks on the line, of the beats from the first kick found to the last)
      const span = ks[ks.length - 1] - ks[0] + 1;
      return { ...r, row, kicks: r.m / span, rms: Math.sqrt(ss / r.m) * 1000 };
    };
    // the row that tells the kicks best: more of them on the line, closer to it
    const lines = [lineOf(1), lineOf(0)].filter(Boolean);
    const score = l => l.kicks - 0.15 * l.rms;
    const best = lines.sort((x, y) => score(y) - score(x))[0];
    const barOk = g.bar.by === 'changes' ? g.bar.vote >= 1.6 || g.bar.pattern : g.bar.pattern;
    // (too few kicks on the line, or too far from it, to trust it: the grid from the peaks, marked to be looked at)
    if (!best || best.kicks < 0.5 || best.rms > 2.5) {
      const out = { ...g, v: 2, exact: false, conf: { kicks: best ? Math.round(best.kicks * 1000) / 1000 : 0, rms: best ? Math.round(best.rms * 100) / 100 : null, row: best ? best.row : null, bar: g.bar }, ok: false };
      exactCache.set(ck, out); return out;
    }
    const period = best.slope, t0 = best.icpt - Math.floor(best.icpt / period) * period;
    const bar0 = t0 + Math.round((g.bar0 - t0) / period) * period;
    const conf = { kicks: Math.round(best.kicks * 1000) / 1000, rms: Math.round(best.rms * 100) / 100, row: best.row, bar: g.bar };
    const out = { bpm: 60 / period, period, t0, bar0, bar: g.bar, v: 2, exact: true, conf, ok: conf.kicks >= 0.6 && conf.rms <= 1.5 && barOk };
    exactCache.set(ck, out);
    if (exactCache.size > 16) exactCache.delete(exactCache.keys().next().value);
    return out;
  }

  // ---------- a grid of pins (stage 2) ----------
  // A grid set by hand is a BPM and a list of pins. A pin says "beat b is at time t" (b counts beats; the bar lines
  // are the beats whose b is a multiple of 4). With one pin the grid is the BPM laid from it, both ways: the usual
  // case, a constant tempo. With several, the beats between two pins are spread evenly over the time between them
  // (a tempo that wanders, a grid that jumps after a break), and before the first pin and after the last the grid
  // runs at the BPM. A grid of pins never leans on the automatic grid, so nothing in it moves when the analysis
  // changes. b may be fractional (a ÷2 leaves an odd beat at a half), the bar lines stay where b is whole and a
  // multiple of 4.
  // pinGrid(model) -> the grid object the views and the decks use: { bpm, period, t0, bar0 } as before (with one
  // pin, exactly the constant grid, from bar 1; with several, the stretch at 0:00), plus pins, beatAt(t), timeAt(b) and
  // at(t): the constant grid of the stretch t is in (what a loop, a jump or sync uses there).
  function pinGrid(m) {
    if (!m || !(m.bpm > 0) || !Array.isArray(m.pins) || !m.pins.length) return null;
    const pins = m.pins.filter(p => p && isFinite(p.t) && isFinite(p.b)).slice().sort((x, y) => x.t - y.t);
    // (pins out of order, or two on one beat, say nothing: kept only when their beats go up with their times)
    const ps = [];
    for (const p of pins) if (!ps.length || (p.t > ps[ps.length - 1].t + 1e-4 && p.b > ps[ps.length - 1].b + 1e-6)) ps.push({ t: p.t, b: p.b, ...(p.f ? { f: 1 } : {}) });
    if (!ps.length) return null;
    const P = 60 / m.bpm, last = ps.length - 1;
    // the stretch t is in: -1 before the first pin, i between pin i and i + 1, last after the last
    const segT = t => { if (t < ps[0].t) return -1; let i = 0; while (i < last && t >= ps[i + 1].t) i++; return i; };
    const segB = b => { if (b < ps[0].b) return -1; let i = 0; while (i < last && b >= ps[i + 1].b) i++; return i; };
    const per = i => (i < 0 || i >= last ? P : (ps[i + 1].t - ps[i].t) / (ps[i + 1].b - ps[i].b));
    const from = i => ps[Math.max(0, i)];
    const beatAt = t => { const i = segT(t), p = from(i); return p.b + (t - p.t) / per(i); };
    const timeAt = b => { const i = segB(b), p = from(i); return p.t + (b - p.b) * per(i); };
    const local = i => {
      const p = from(i), period = per(i);
      // (a bar line on this stretch's line: the one nearest its pin)
      const bar0 = p.t + (4 * Math.round(p.b / 4) - p.b) * period;
      return { bpm: 60 / period, period, t0: bar0, bar0 };
    };
    // (the grid as a whole: the stretch at 0:00, from bar 1, the first bar line of the track)
    const i0 = segT(0), p0 = from(i0), P0 = per(i0), k1 = 4 * Math.ceil(beatAt(-0.02) / 4 - 1e-9), bar1 = p0.t + (k1 - p0.b) * P0;
    const g = { bpm: m.bpm, period: P0, t0: bar1, bar0: bar1, pins: ps, beatAt, timeAt };
    if (ps.length === 1) { g.bpm = m.bpm; g.at = () => g; return g; }
    g.bend = true;
    g.at = t => ({ ...local(segT(t)), pins: ps, beatAt, timeAt, bend: true });
    return g;
  }
  // the same three for any grid, with pins or a plain constant one ({ period, bar0 })
  function gridBeatAt(g, t) { return g.beatAt ? g.beatAt(t) : (t - g.bar0) / g.period; }
  function gridTimeAt(g, b) { return g.timeAt ? g.timeAt(b) : g.bar0 + b * g.period; }
  function gridLocal(g, t) { return g && g.at ? g.at(t) : g; }
  // The largest distance (ms) between the beats of two grids over 0..dur, and whether their bars agree
  function gridApart(a, b, dur) {
    let worst = 0, bars = true;
    const k0 = Math.ceil(gridBeatAt(a, 0)), k1 = Math.floor(gridBeatAt(a, dur));
    for (let k = k0; k <= k1; k++) {
      const ta = gridTimeAt(a, k), kb = Math.round(gridBeatAt(b, ta));
      worst = Math.max(worst, Math.abs(gridTimeAt(b, kb) - ta));
      if (((kb - k) % 4 + 4) % 4 !== 0) bars = false;
    }
    return { ms: worst * 1000, bars };
  }
  // A model as it is kept: its pins in order, rounded (a µs, a millionth of a beat), a lone pin that isn't yours
  // on the bar line nearest it (the same grid), and what the builds before pins read: a warp at bpmSet (the same
  // BPM) from `anchor` (the first pin's bar line), `fixed` when that pin is yours and on it. -> { v: 4, bpm, pins,
  // anchor, fixed } (k, what was corrected, is the caller's)
  function pinStore(m) {
    let pins = m.pins.map(p => ({ t: p.t, b: p.b, ...(p.f ? { f: 1 } : {}) })).sort((x, y) => x.t - y.t);
    if (pins.length === 1 && !pins[0].f) {
      const g = pinGrid({ bpm: m.bpm, pins }), kb = 4 * Math.round(pins[0].b / 4);
      pins = [{ t: g.timeAt(kb), b: 0 }];
    }
    pins = pins.map(p => ({ t: Math.round(p.t * 1e6) / 1e6, b: Math.round(p.b * 1e6) / 1e6, ...(p.f ? { f: 1 } : {}) }));
    const out = { v: 4, bpm: m.bpm, pins };
    const g = pins.length ? pinGrid(out) : null;
    if (g) {
      const a = g.timeAt(4 * Math.round(pins[0].b / 4));
      out.anchor = Math.round(a * 1e6) / 1e6;
      if (pins[0].f && Math.abs(a - pins[0].t) < 1e-4) out.fixed = true;
    }
    return out;
  }
  // The corrections of before pins (kept in the track's details by the builds before 13 Nov 2026, stage 2):
  // e: { bar, ms, mul, v } relative to an automatic grid, or { anchor, fixed (, ms, bar) } a warp; typed: the BPM
  // typed (bpmSet), or null.
  // legacyApply(base, e, typed): the grid they gave, from the grid they were made on (base: the warp needs none,
  // only typed; a BPM typed without a warp: the grid fitted near it, beatGrid at that BPM).
  function legacyApply(base, e, typed) {
    if (e && e.anchor != null) {
      if (!(typed > 40 && typed < 250)) return null;
      const period = 60 / typed, b0 = e.anchor + (e.ms || 0) / 1000 + (e.bar || 0) * period;
      return { bpm: typed, period, t0: b0, bar0: b0, edited: true, warped: true };
    }
    if (!base) return null;
    if (!e) return base;
    const mul = e.mul || 1, period = base.period / mul, off = (e.ms || 0) / 1000;
    return { bpm: base.bpm * mul, period, t0: base.t0 + off, bar0: base.bar0 + off + (e.bar || 0) * period, edited: true };
  }
  // legacyPins(e, typed, g, dur): that grid g as one pin and a BPM: a warp's own bar (pinned when it was fixed);
  // else the bar line nearest the middle of the track. A BPM typed without a warp: that BPM exactly (it wasn't
  // applied exactly before: the grid ran at the fitted tempo), so that grid differs from g away from the pin.
  function legacyPins(e, typed, g, dur) {
    if (e && e.anchor != null) return { bpm: g.bpm, pins: [{ t: e.anchor + (e.ms || 0) / 1000, b: -(e.bar || 0), ...(e.fixed ? { f: 1 } : {}) }] };
    const kb = 4 * Math.round(gridBeatAt(g, dur > 0 ? dur / 2 : g.bar0) / 4);
    return { bpm: typed != null ? typed * ((e && e.mul) || 1) : g.bpm, pins: [{ t: gridTimeAt(g, kb), b: 0 }], typed: typed != null };
  }
  // (what to compare to see whether a grid changed)
  function gridSig(g) { return g ? g.bar0 + '|' + g.period + (g.bend ? '|' + g.pins.map(p => p.t + ':' + p.b).join(',') : '') : ''; }

  // ---------- settings ----------
  const KEY = 'waveView';
  // (zoom: the single player's and deck A's; zoomB: deck B's; zoomLink: one zoom for both decks)
  const DEFAULTS = { split: false, main: 'analysis', top: 'audio', zoom: 5, zoomB: 0, zoomLink: false, runBelow: false, fullness: 0.35, fill: 1 };
  let settings = Object.assign({}, DEFAULTS), loaded = false;
  const store = () => (root.chrome && chrome.storage && chrome.storage.local) || null;
  function clean(s) {
    const o = Object.assign({}, DEFAULTS, s || {});
    o.split = !!o.split;
    if (!TYPES.includes(o.main)) o.main = DEFAULTS.main;
    if (!TYPES.includes(o.top)) o.top = DEFAULTS.top;
    o.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(o.zoom) || DEFAULTS.zoom));
    o.zoomB = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(o.zoomB) || o.zoom));
    o.zoomLink = !!o.zoomLink;
    o.runBelow = !!o.runBelow;
    const unit = (v, d) => { v = Number(v); return isFinite(v) ? Math.max(0, Math.min(1, v)) : d; };
    o.fullness = unit(o.fullness, DEFAULTS.fullness); o.fill = unit(o.fill, DEFAULTS.fill);
    return o;
  }
  // first: what an older setting implies, when there's no waveView saved yet (Local tracks: show art)
  const ready = (async () => {
    try {
      const st = store();
      if (st) {
        const r = await st.get([KEY, 'trackArtLocal']);
        if (r && r[KEY]) settings = clean(r[KEY]);
        else if (r && r.trackArtLocal === true) settings = clean({ main: 'art' });
      }
    } catch (e) { /* defaults */ }
    loaded = true;
    return settings;
  })();
  let saveTimer = null;
  function set(patch) {
    settings = clean(Object.assign({}, settings, patch));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { const st = store(); if (st) st.set({ [KEY]: settings }).catch(() => {}); }, 250);
    if (root.dispatchEvent) root.dispatchEvent(new CustomEvent('uz-waveview', { detail: Object.assign({}, settings, { changed: Object.keys(patch) }) }));
  }

  // ---------- drawing ----------
  function colors() {
    const pal = typeof root.getThemePalette === 'function' ? root.getThemePalette() : null;
    const css = n => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const m = /^#([0-9a-f]{6})$/i.exec(v);
      return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4), 16)] : null;
    };
    const amber = (pal && pal.intensityStops[2]) || css('--amber') || [230, 170, 60];
    // (the text colour itself: the beat lines; the loudest parts may be another colour, the style's --wave-peak)
    const text = css('--text') || (pal && pal.intensityStops[3]) || [235, 235, 235];
    const low = (pal && pal.bassStops[1]) || [90, 160, 100];
    const dim = (pal && pal.intensityStops[1]) || amber;
    const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
    const cue = css('--cue') || [31, 181, 214];
    return {
      cue: rgba(cue, 1), loopFill: rgba(cue, 0.16),
      // the Remix loop's beats from elsewhere (player.js: rmxLoopView)
      remix: rgba(amber, 0.95), remixFill: rgba(amber, 0.2),
      // the same colours as the analysed energy (player.js: paintEnergy), whatever the theme: the mids and
      // highs in the accent colour (its intensity), the kicks in the text colour (its kick ticks), the bass green
      low: rgba(low, 1), midhi: rgba(amber, 1), kick: (pal && pal.kick) || rgba(text, 0.92),
      // (bar lines neutral, so the playhead is the only accent-coloured line)
      beat: rgba(text, 0.35), bar: rgba(text, 0.75), center: rgba(css('--amber') || amber, 1), amber, text,
      // (Settings → Waveform → Played part: shaded darker, or washed out toward the screen's own colour)
      past: document.documentElement.dataset.fade === 'light' ? rgba((pal && pal.screenRgb) || [255, 255, 255], 0.5) : 'rgba(0,0,0,.18)',
      fillA: pal ? pal.waveFill : 1, edgeA: pal ? pal.waveEdge : 0
    };
  }

  // The audio waveform from the peaks (until the hits are computed), one column per pixel (frameAt(x): the
  // track's frame at pixel x), laid out like the analysed energy: the mids and highs above the middle line
  // (accent colour), the bass below it (green). Zoomed in further than one frame per pixel, the values are
  // interpolated, so the shapes stay smooth.
  function drawColumns(ctx, pk, w, h, frameAt, cols) {
    const d = pk.data, n = pk.n, y0 = Math.round(h * 0.49), pad = Math.max(2, h * 0.04), up = y0 - 1 - pad, dn = h - y0 - 1 - pad;
    const low = new Path2D(), mh = new Path2D();
    const val = (f, o) => {   // interpolated value of band o at fractional frame f
      const a = Math.floor(f), t = f - a;
      if (a < 0 || a >= n) return 0;
      const v0 = d[4 * a + o], v1 = a + 1 < n ? d[4 * (a + 1) + o] : v0;
      return v0 + (v1 - v0) * t;
    };
    for (let x = 0; x < w; x++) {
      const f0 = frameAt(x), f1 = frameAt(x + 1);
      if (f1 <= 0 || f0 >= n) continue;
      let lo = 0, mi = 0, hi = 0;
      if (f1 - f0 < 1) {
        const f = (f0 + f1) / 2;
        lo = val(f, 1); mi = val(f, 2); hi = val(f, 3);
      } else {
        const a = Math.max(0, Math.floor(f0)), b = Math.min(n, Math.ceil(f1));
        for (let f = a; f < b; f++) {
          const o = 4 * f;
          if (d[o + 1] > lo) lo = d[o + 1];
          if (d[o + 2] > mi) mi = d[o + 2];
          if (d[o + 3] > hi) hi = d[o + 3];
        }
      }
      const hu = Math.max(mi, hi * 0.8) / 255 * up, hd = lo / 255 * dn;
      if (hu > 0.3) mh.rect(x, y0 - 1 - hu, 1, hu);
      if (hd > 0.3) low.rect(x, y0 + 1, 1, hd);
    }
    ctx.fillStyle = cols.midhi; ctx.fill(mh);
    ctx.fillStyle = cols.low; ctx.fill(low);
  }

  // The audio waveform from the hits (computeHits), frameAt(x): the hits' frame at pixel x. Laid out and
  // coloured like the analysed energy, in every theme: the mids' and highs' hits (snares, claps, hats) rise
  // above the middle line in the accent colour, the kicks (the low end's hits) hang below it in the text
  // colour, and the bass is a faint green shape behind the kicks. Two settings shape it:
  //   fullness: how much of the bass shows (0: only its loudest parts, faint; 1: all of it, stronger);
  //   fill: the shapes' fill, from none (their outlines only) to solid. Below solid, inner outlines fade in.
  // Zoomed in further than a frame per pixel, the values are interpolated.
  function drawHits(ctx, hits, w, h, frameAt, cols, dpr) {
    const d = hits.data, n = hits.n, full = settings.fullness, fill = settings.fill;
    dpr = dpr || 1;
    const y0 = Math.round(h * 0.49), pad = Math.max(2 * dpr, h * 0.045), gap = Math.max(1, Math.round(dpr));
    const up = y0 - gap - pad, dn = h - y0 - gap - pad;
    const x0 = -2, x1 = w + 2, m = x1 - x0 + 1;
    const ut = new Float32Array(m), kb = new Float32Array(m), bb = new Float32Array(m);
    const val = (f, o) => {
      const a = Math.floor(f), t = f - a;
      if (a < 0 || a >= n) return 0;
      const v0 = d[3 * a + o], v1 = a + 1 < n ? d[3 * (a + 1) + o] : v0;
      return v0 + (v1 - v0) * t;
    };
    const bexp = 2.2 - 1.4 * full;
    let any = false;
    for (let i = 0; i < m; i++) {
      const x = x0 + i, f0 = frameAt(x), f1 = frameAt(x + 1);
      let k = 0, s = 0, b = 0;
      if (f1 > 0 && f0 < n) {
        if (f1 - f0 < 1) {
          const f = (f0 + f1) / 2;
          k = val(f, 0); s = val(f, 1); b = val(f, 2);
        } else {
          const a = Math.max(0, Math.floor(f0)), e = Math.min(n, Math.ceil(f1));
          for (let f = a; f < e; f++) {
            const o = 3 * f;
            if (d[o] > k) k = d[o];
            if (d[o + 1] > s) s = d[o + 1];
            if (d[o + 2] > b) b = d[o + 2];
          }
        }
        any = true;
      }
      ut[i] = y0 - gap - Math.pow(s / 255, 0.8) * up;          // the mids and highs, up
      kb[i] = y0 + gap + Math.pow(k / 255, 0.8) * dn;          // the kicks, down
      bb[i] = y0 + gap + Math.pow(b / 255, bexp) * 0.8 * dn;   // the bass, down, behind the kicks
    }
    if (!any) return;
    const X = i => x0 + i + 0.5;
    const line = ys => {   // a polyline through the columns
      const p = new Path2D();
      for (let i = 0; i < m; i++) { if (i) p.lineTo(X(i), ys[i]); else p.moveTo(X(i), ys[i]); }
      return p;
    };
    const area = (ys, base) => {   // from the base line out to ys
      const p = line(ys);
      p.lineTo(X(m - 1), base); p.lineTo(X(0), base); p.closePath();
      return p;
    };
    ctx.save();
    ctx.lineJoin = 'round';
    // The outlines are INNER borders: drawn at twice their width, clipped to their shape, so only the inside
    // half shows and the shapes keep exactly their size whatever the fill. They grow stronger as the fill
    // fades (none at solid, full from half way down), and are thinner over a long stretch, where every pixel
    // holds many hits.
    const ol = Math.max(cols.edgeA || 0, Math.min(1, 2 * (1 - fill))), lw = (frameAt(1) - frameAt(0) > 20 * dpr ? 1 : 1.25) * dpr;
    const outline = (ys, base, color, alpha, width) => {
      const shape = area(ys, base);
      ctx.save(); ctx.clip(shape);
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2 * width; ctx.stroke(line(ys));
      ctx.restore();
    };
    // the bass, behind
    if (fill > 0) { ctx.globalAlpha = (0.2 + 0.35 * full) * fill * (cols.fillA == null ? 1 : Math.sqrt(cols.fillA)); ctx.fillStyle = cols.low; ctx.fill(area(bb, y0 + gap)); }
    if (ol > 0) outline(bb, y0 + gap, cols.low, (0.55 + 0.3 * full) * ol, Math.min(lw, dpr));
    // the hits
    if (fill > 0) {
      ctx.globalAlpha = 0.95 * fill * (cols.fillA == null ? 1 : cols.fillA);
      ctx.fillStyle = cols.midhi; ctx.fill(area(ut, y0 - gap));
      ctx.fillStyle = cols.kick; ctx.fill(area(kb, y0 + gap));
    }
    if (ol > 0) {
      outline(ut, y0 - gap, cols.midhi, ol, lw);
      outline(kb, y0 + gap, cols.kick, ol, lw);
    }
    ctx.restore();
  }

  // The whole track's audio waveform onto a canvas (already sized): from the hits, or (until they're
  // computed) the older 3-band drawing from the peaks.
  function paintAudio(canvas, pk, hits, dpr) {
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (hits && hits.n) { drawHits(ctx, hits, w, h, x => x / w * hits.n, colors(), dpr || root.devicePixelRatio || 1); return; }
    if (!pk || !pk.n) return;
    drawColumns(ctx, pk, w, h, x => x / w * pk.n, colors());
  }

  // A stretch of the music, from time t0 at x = 0, spp seconds per (canvas) pixel: the audio waveform or the
  // analysed energy, and the beat grid. o: { type, pk, energy, dur, grid, dpr }
  function drawRange(ctx, w, h, t0, spp, o) {
    const cols = colors(), tAt = x => t0 + x * spp;
    if (o.type === 'audio' && o.hits) drawHits(ctx, o.hits, w, h, x => tAt(x) * HIT_RATE, cols, o.dpr);
    // (hitsPending: the hits are on their way, a second or two: nothing until then, rather than the peaks'
    // drawing for a moment and a jump to the hits; the peaks only if there won't be hits)
    else if (o.type === 'audio' && o.pk && !o.hitsPending) drawColumns(ctx, o.pk, w, h, x => tAt(x) * RATE, cols);
    else if (o.type === 'analysis' && o.energy && o.energy.bucketIntensity && o.dur > 0) {
      const e = o.energy, nb = e.bucketIntensity.length, top = e.treblePresence && e.treblePresence.length === nb ? e.treblePresence : e.bucketIntensity;
      const ic = typeof root.intensityColorRgb === 'function' ? root.intensityColorRgb : () => cols.amber;
      const bc = typeof root.bassColorRgb === 'function' ? root.bassColorRgb : () => [90, 160, 100];
      const y0 = h * 0.49, gap = 3, topH = y0 - gap - 2, botH = h - y0 - gap - 2;
      const bw = (o.dur / nb) / spp;   // one bucket, in pixels
      const b0 = Math.max(0, Math.floor(tAt(0) / o.dur * nb)), b1 = Math.min(nb - 1, Math.ceil(tAt(w) / o.dur * nb));
      ctx.globalAlpha = cols.fillA == null ? 1 : cols.fillA;
      const eT = cols.edgeA > 0 ? new Path2D() : null, eB = cols.edgeA > 0 ? new Path2D() : null;
      for (let b = b0; b <= b1; b++) {
        const x = (b * o.dur / nb - t0) / spp, v = top[b], bv = e.bassPresence ? e.bassPresence[b] : 0;
        const c = ic(v), cb = bc(bv);
        ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
        const th = Math.max(2, v / 255 * topH); ctx.fillRect(x, y0 - gap - th, Math.ceil(bw) + 1, th);
        ctx.fillStyle = `rgb(${cb[0] | 0},${cb[1] | 0},${cb[2] | 0})`;
        const bh = Math.max(2, bv / 255 * botH); ctx.fillRect(x, y0 + gap, Math.ceil(bw) + 1, bh);
        if (eT) { const f = b === b0 ? 'moveTo' : 'lineTo'; eT[f](x, y0 - gap - th); eT.lineTo(x + bw, y0 - gap - th); eB[f](x, y0 + gap + bh); eB.lineTo(x + bw, y0 + gap + bh); }
      }
      ctx.globalAlpha = 1;
      // (a lighter look, when the UI style asks: the shapes' outer edge as a line, in their full colour)
      if (eT) {
        ctx.globalAlpha = cols.edgeA; ctx.lineWidth = Math.max(1, Math.round(o.dpr || 1));
        ctx.strokeStyle = `rgb(${cols.amber.map(v => v | 0).join(',')})`; ctx.stroke(eT);
        ctx.strokeStyle = cols.low; ctx.stroke(eB);
        ctx.globalAlpha = 1;
      }
    }
    const dpr = o.dpr || 1;
    // the beat grid: beats (thin), bars of 4 (accent, with a tab at the top); a little past both edges, so a
    // line on the edge between two tiles is drawn whole
    if (o.grid && (o.type === 'audio' || o.type === 'analysis')) {
      // (beats counted as the grid counts them: with pins, each stretch at its own tempo)
      const g = o.grid, k0 = Math.ceil(gridBeatAt(g, tAt(-6 * dpr)) - 1e-6), k1 = Math.floor(gridBeatAt(g, tAt(w + 6 * dpr)) + 1e-6);
      for (let k = k0; k <= k1; k++) {
        const t = gridTimeAt(g, k);
        if (t < 0 || (o.dur && t > o.dur)) continue;
        const x = Math.round((t - t0) / spp), bar = ((k % 4) + 4) % 4 === 0;
        if (bar) {
          ctx.fillStyle = cols.bar;
          ctx.fillRect(x - dpr, 0, 2 * dpr, h);
          ctx.beginPath(); ctx.moveTo(x - 5 * dpr, 0); ctx.lineTo(x + 5 * dpr, 0); ctx.lineTo(x, 6 * dpr); ctx.closePath(); ctx.fill();
        } else {
          ctx.fillStyle = cols.beat;
          ctx.fillRect(x - dpr / 2, 0, dpr, h);
        }
      }
    }
    // a loop: its stretch shaded in the cue's colour, its ends marked
    if (o.loop && o.loop.end > o.loop.start) {
      const x0 = (o.loop.start - t0) / spp, x1 = (o.loop.end - t0) / spp;
      if (x1 > 0 && x0 < w) {
        ctx.fillStyle = cols.loopFill;
        ctx.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), h);
        ctx.fillStyle = cols.cue;
        for (const x of [x0, x1]) if (x > -4 * dpr && x < w + 4 * dpr) ctx.fillRect(Math.round(x) - dpr, 0, 2 * dpr, h);
      }
      // the Remix loop's beats in this repetition of the loop (player.js: rmxLoopView): from elsewhere in the track
      // tinted in the accent colour, with a bar along the top; reversed: a ◁ at the top; a roll: stripes; silent: dark
      for (const m of o.loop.marks || []) {
        const a = (m.a - t0) / spp, b = (m.b - t0) / spp;
        if (b <= 0 || a >= w) continue;
        const xa = Math.max(0, Math.round(a)) + dpr, xb = Math.min(w, Math.round(b)) - dpr;
        if (xb <= xa) continue;
        if (m.kind === 'gap') { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(xa, 0, xb - xa, h); continue; }
        ctx.fillStyle = cols.remixFill; ctx.fillRect(xa, 0, xb - xa, h);
        ctx.fillStyle = cols.remix; ctx.fillRect(xa, 0, xb - xa, 3 * dpr);
        if (m.kind === 'rev') {
          const cx = (xa + xb) / 2, s = 5 * dpr;
          ctx.beginPath(); ctx.moveTo(cx - s, 9 * dpr); ctx.lineTo(cx + s, 4 * dpr + 1); ctx.lineTo(cx + s, 14 * dpr); ctx.closePath(); ctx.fill();
        } else if (m.kind === 'roll') {
          ctx.fillStyle = cols.remixFill;
          for (let x = xa; x < xb; x += 6 * dpr) ctx.fillRect(x, 0, 2 * dpr, h);
        }
      }
    }
    // the cue point: a line in its own colour, with a tab at the bottom (the bar lines have theirs at the top)
    if (o.cue != null && o.cue >= 0 && (!o.dur || o.cue <= o.dur)) {
      const x = Math.round((o.cue - t0) / spp);
      if (x > -8 * dpr && x < w + 8 * dpr) {
        ctx.fillStyle = cols.cue;
        ctx.fillRect(x - dpr, 0, 2 * dpr, h);
        ctx.beginPath(); ctx.moveTo(x - 6 * dpr, h); ctx.lineTo(x + 6 * dpr, h); ctx.lineTo(x, h - 8 * dpr); ctx.closePath(); ctx.fill();
      }
    }
  }

  // The scrolling view, one frame (kept for anything that draws it frame by frame; the panels use
  // createScroller): the music at pos ± zoom seconds, the playhead in the middle.
  function paintScroll(canvas, o) {
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const spp = 2 * o.zoom / w, dpr = o.dpr || 1, cols = colors();
    drawRange(ctx, w, h, o.pos - w / 2 * spp, spp, o);
    ctx.fillStyle = cols.past; ctx.fillRect(0, 0, Math.floor(w / 2), h);
    ctx.fillStyle = cols.center; ctx.fillRect(Math.round(w / 2 - dpr), 0, 2 * dpr, h);
  }

  // ---------- the scrolling view, smooth ----------
  // The music is drawn once into tiles (canvases 1024 px wide, a few seconds each) laid side by side on a
  // strip, and the strip slides under the fixed playhead. While the music plays at a steady speed, the
  // sliding is a Web Animation: the browser's compositor moves it every screen frame at exactly constant
  // speed, even while the page is busy (analysis, the list…), so it never stutters. The page only keeps it
  // in step with the music: follow() is given the real position from time to time and corrects any drift
  // by speeding the animation up or down by at most 1 % (invisible), or jumps if it's far off (a seek).
  // Tiles are drawn ahead of the playhead and dropped behind it.
  const TILE = 1024;                   // css px
  // id: whose zoom it shows ('a': the single player and deck A; 'b': deck B)
  function createScroller(box, idOf = 'a') {
    // (its zoom's id: 'a' or 'b'; a function for a view whose deck can change places, e.g. a slot's Deck)
    const zid = () => (typeof idOf === 'function' ? idOf() : idOf);
    const strip = document.createElement('div');
    strip.className = 'wv-strip';
    const past = document.createElement('div'), center = document.createElement('div');
    past.className = 'wv-past'; center.className = 'wv-center';
    // the warp's handles (player.js: warpAttach): on the strip, so they move with the music; their band on top
    const layer = document.createElement('div');
    layer.className = 'wv-handles';
    strip.appendChild(layer);
    box.append(strip, past, center);
    let hook = null;   // called with the time at the view's centre once it's placed (paused), null while it runs
    const tiles = new Map();
    let data = null, geo = '', W = 0, H = 0, dpr = 1, pps = 1, zoom = 5;
    let anim = null, aFrom = 0, aRate = 0, aErr = 0, lastPos = 0;
    // paused, after zooming at the mouse: the view's own centre (the playhead then wherever it falls in it);
    // null: the view follows the playhead (always while playing)
    let free = null;
    const xOf = pos => W / 2 - pos * pps;
    const tx = pos => `translate3d(${xOf(pos).toFixed(2)}px,0,0)`;
    function measure() {
      const g = `${box.clientWidth}|${box.clientHeight}|${window.devicePixelRatio || 1}|${zoomOf(zid())}`;
      if (g === geo) return false;
      geo = g;
      W = box.clientWidth; H = box.clientHeight; dpr = window.devicePixelRatio || 1; zoom = zoomOf(zid());
      pps = W > 0 ? W / (2 * zoom) : 1;
      return true;
    }
    function clearTiles() { for (const c of tiles.values()) c.remove(); tiles.clear(); }
    function drawTile(i) {
      const c = document.createElement('canvas');
      c.width = Math.round(TILE * dpr); c.height = Math.max(1, Math.round(H * dpr));
      c.style.cssText = `position:absolute;top:0;left:${i * TILE}px;width:${TILE}px;height:100%`;
      const spp = 1 / (pps * dpr);   // seconds per canvas pixel
      if (data) drawRange(c.getContext('2d'), c.width, c.height, i * TILE / pps, spp, Object.assign({ dpr }, data));
      strip.appendChild(c);
      tiles.set(i, c);
    }
    // the tiles from a little behind the left edge to `ahead` seconds past the right one
    function ensure(pos, ahead) {
      if (!W || !H) return;
      const i0 = Math.floor((pos - zoom) * pps / TILE) - 1, i1 = Math.floor((pos + zoom + ahead) * pps / TILE) + 1;
      for (const [i, c] of tiles) if (i < i0 - 1 || i > i1 + 2) { c.remove(); tiles.delete(i); }
      for (let i = Math.max(i0, Math.floor(-zoom * pps / TILE) - 1); i <= i1; i++) if (!tiles.has(i)) drawTile(i);
    }
    function stopAnim() { if (anim) { anim.cancel(); anim = null; } aRate = 0; }
    // where the animation is now (its time is the frame's: this moment is a little later in it)
    function animPos() {
      if (!anim) return lastPos;
      const tl = document.timeline.currentTime, ct = anim.currentTime || 0;
      return aFrom + (ct + (anim.pending || tl == null ? 0 : (performance.now() - tl) * anim.playbackRate)) / 1000 * aRate;
    }
    // the playhead's line and the played shade: at the centre, or where the playhead is in a free view
    function head(pos, c) {
      if (free == null) { center.style.left = ''; past.style.width = ''; return; }
      const x = W / 2 + (pos - c) * pps;
      center.style.left = x.toFixed(1) + 'px';
      past.style.width = Math.max(0, Math.min(W, x)).toFixed(1) + 'px';
    }
    // the position, drawn as is (paused, scratching…)
    function place(pos) {
      if (measure()) clearTiles();
      stopAnim();
      // (the playhead moved out of the view, a seek or a move: the view follows it again; a zoom keeps it free)
      if (free != null && Math.abs(pos - lastPos) > 1e-6 && Math.abs(pos - free) > zoom) free = null;
      lastPos = pos;
      const c = free == null ? pos : free;
      strip.style.transform = tx(c);
      ensure(c, 2);
      head(pos, c);
      if (hook) hook(c);
    }
    // the mouse wheel at a point of the view (frac: 0…1 across it): paused, the music under the mouse stays under
    // it (the view leaves the playhead); playing, the zoom is around the playhead, which the view follows
    function zoomAt(frac, steps) {
      if (anim) { zoomBy(steps, zid()); return; }
      measure();
      const c0 = free == null ? lastPos : free, t = c0 + (frac - 0.5) * 2 * zoom;
      zoomBy(steps, zid());
      measure();
      free = t - (frac - 0.5) * 2 * zoomOf(zid());
      place(lastPos);
    }
    // the music runs at `rate` from `pos`, its real position at the moment `at` (performance.now(); now if
    // not given)
    function follow(pos, rate, playing, at) {
      if (!playing || !rate) { place(pos); return; }
      if (free != null) { free = null; head(pos, pos); }   // (playing: the view follows the playhead again)
      if (measure()) { clearTiles(); stopAnim(); }
      const now = performance.now();
      if (at == null || at > now) at = now;
      ensure(pos, Math.abs(rate) * 12);
      if (anim && Math.abs(rate - aRate) < 0.004 * Math.max(1, Math.abs(rate))) {
        if (anim.pending) return;   // (a speed change on its way to the compositor)
        const err = pos + (now - at) / 1000 * rate - animPos();
        if (Math.abs(err) < 0.06) {
          aErr = aErr * 0.5 + err * 0.5;   // (the position read is a little noisy)
          // within 4 ms: nothing to do (and nothing for the compositor to redo); beyond: up to 3 % faster or
          // slower (not something you can see) until it has caught up, in about a second; further off than
          // 60 ms (a seek, a stall): it jumps
          const want = Math.abs(aErr) < 0.004 ? 1 : 1 + Math.max(-0.03, Math.min(0.03, aErr / Math.abs(rate)));
          if (Math.abs(want - anim.playbackRate) > 0.0005) anim.updatePlaybackRate(want);
          return;
        }
      }
      // (re)start: from there, at this speed, for an hour. It starts at the moment the position was read: an
      // animation would otherwise start with the next frame (or later, when the page is busy), while the music
      // doesn't wait, and it would run that much behind.
      stopAnim();
      if (hook) hook(null);
      strip.style.transform = tx(pos);
      aFrom = pos; aRate = rate; aErr = 0;
      anim = strip.animate([{ transform: tx(pos) }, { transform: tx(pos + 3600 * rate) }], { duration: 3600000, easing: 'linear', fill: 'forwards' });
      try { anim.startTime = at; } catch (e) { /* starts with the next frame */ }
    }
    // what to draw (null: nothing); only redrawn when something in it changed
    function set(d) {
      const same = data && d && data.type === d.type && data.pk === d.pk && data.hits === d.hits && !!data.hitsPending === !!d.hitsPending && data.energy === d.energy && data.dur === d.dur &&
        gridSig(data.grid) === gridSig(d.grid) && data.theme === d.theme && data.cue === d.cue &&
        (data.loop && data.loop.start) === (d.loop && d.loop.start) && (data.loop && data.loop.end) === (d.loop && d.loop.end) &&
        (data.loop && data.loop.sig) === (d.loop && d.loop.sig);
      if (same) return;
      data = d;
      box.classList.toggle('wv-on', !!d);
      measure();
      clearTiles();
      ensure(anim ? animPos() : lastPos, Math.abs(aRate) * 12 || 2);
    }
    // the size, the zoom or the colours changed
    function refresh() { geo = ''; measure(); clearTiles(); const p = anim ? animPos() : lastPos, r = aRate, on = !!anim; stopAnim(); if (on) follow(p, r, true); else place(p); }
    // (pos: the time at the view's centre, for what's under a point of it: scrollTimeAt)
    return { get id() { return zid(); }, place, follow, set, refresh, zoomAt, get zoom() { measure(); return zoom; }, get pos() { return anim ? animPos() : (free == null ? lastPos : free); }, get free() { return free != null; }, el: strip,
      layer, get pps() { return pps; }, get running() { return !!anim; }, set onPlace(fn) { hook = fn; } };
  }

  // The cue point over a view of the whole track: a line at its place (frac: 0..1 of the track; null: none)
  function cueMark(region) {
    addCss();
    const el = document.createElement('div');
    el.className = 'wv-cue'; el.hidden = true;
    region.appendChild(el);
    return { set(frac) { const on = frac != null && frac >= 0 && frac <= 1; el.hidden = !on; if (on) el.style.left = (frac * 100).toFixed(4) + '%'; }, el };
  }

  // A loop over a view of the whole track: its stretch shaded (fractions of the track; null: none)
  function loopMark(region) {
    addCss();
    const el = document.createElement('div');
    el.className = 'wv-loop'; el.hidden = true;
    region.appendChild(el);
    return { set(a, b) { const on = a != null && b > a; el.hidden = !on; if (on) { el.style.left = (a * 100).toFixed(4) + '%'; el.style.width = ((b - a) * 100).toFixed(4) + '%'; } }, el };
  }

  // The Remix loop's borrowed beats over a view of the whole track: where each comes from (fractions of the
  // track: [{ f0, f1, on }], on: the one playing), redrawn only when the list changes
  function srcMarks(region) {
    addCss();
    const box = document.createElement('div');
    box.className = 'wv-srcs';
    region.appendChild(box);
    let sig = '';
    return {
      set(list) {
        const s = (list || []).map(m => `${m.f0.toFixed(5)},${m.f1.toFixed(5)},${m.on ? 1 : 0}`).join(';');
        if (s === sig) return;
        sig = s;
        box.replaceChildren(...(list || []).map(m => {
          const el = document.createElement('div');
          el.className = 'wv-src' + (m.on ? ' on' : '');
          el.style.left = (m.f0 * 100).toFixed(4) + '%';
          el.style.width = (Math.max(0, m.f1 - m.f0) * 100).toFixed(4) + '%';
          return el;
        }));
      }, el: box
    };
  }

  // the time under a point of the scrolling view (x in css px across width cw)
  const scrollTimeAt = (x, cw, pos, zoom) => pos + (x - cw / 2) / cw * 2 * zoom;

  // a view's zoom (the seconds shown each side of its playhead): each deck its own, or one for both (zoomLink)
  function zoomOf(id) { return id === 'b' && !settings.zoomLink ? settings.zoomB : settings.zoom; }
  // zoom by wheel steps (in: smaller window), that view's (both, linked)
  function zoomBy(steps, id = 'a') {
    const f = Math.pow(1.15, steps);
    if (settings.zoomLink) set({ zoom: settings.zoom * f, zoomB: settings.zoom * f });
    else if (id === 'b') set({ zoomB: settings.zoomB * f });
    else set({ zoom: settings.zoom * f });
  }

  // ---------- a small menu at the pointer (the beat grid's corrections) ----------
  // items: [{ label, act, keep }] (keep: the menu stays open, for repeated nudges); null: a separator
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function popMenu(x, y, items, title) {
    addCss();
    closeMenu();
    const m = document.createElement('div');
    m.className = 'wv-menu';
    if (title) m.appendChild(Object.assign(document.createElement('div'), { className: 'wv-menu-h', textContent: title }));
    for (const it of items) {
      if (!it) { m.appendChild(Object.assign(document.createElement('div'), { className: 'wv-menu-sep' })); continue; }
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = it.label;
      if (it.hint) b.title = it.hint;
      // (a choice that opens a box of its own, Type the BPM: that box stays; only this menu goes)
      b.addEventListener('click', e => { e.stopPropagation(); it.act(); if (!it.keep) { if (menuEl === m) closeMenu(); else m.remove(); } });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    menuEl = m;
    const away = e => { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', away, true); } };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    const esc = e => { if (e.key === 'Escape') { closeMenu(); document.removeEventListener('keydown', esc, true); } };
    document.addEventListener('keydown', esc, true);
  }

  // a small box at the pointer to type a value (the BPM): Enter or OK to keep it, Esc or a click elsewhere to leave
  function popInput(x, y, { title = '', value = '', placeholder = '', hint = '', onOk }) {
    addCss();
    closeMenu();
    const m = document.createElement('div');
    m.className = 'wv-menu wv-input';
    if (title) m.appendChild(Object.assign(document.createElement('div'), { className: 'wv-menu-h', textContent: title }));
    const row = document.createElement('div'); row.className = 'wv-input-row';
    const inp = Object.assign(document.createElement('input'), { type: 'text', value, placeholder });
    inp.setAttribute('inputmode', 'decimal');
    const ok = Object.assign(document.createElement('button'), { type: 'button', textContent: 'OK' });
    row.append(inp, ok); m.appendChild(row);
    if (hint) m.appendChild(Object.assign(document.createElement('div'), { className: 'wv-menu-h', textContent: hint }));
    const done = () => { const v = inp.value; closeMenu(); onOk(v); };
    ok.addEventListener('click', e => { e.stopPropagation(); done(); });
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') closeMenu(); });
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    menuEl = m;
    const away = e => { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', away, true); } };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    inp.focus(); inp.select();
  }

  // ---------- the buttons ----------
  const ICONS = {
    split: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2" y="2" width="12" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="11" width="12" height="3" rx="1" fill="currentColor"/></svg>',
    art: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="5.5" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9 13.5l3-5.5 3 5.5z" fill="currentColor"/><path d="M2 13.5h5" stroke="currentColor" stroke-width="1.4"/></svg>',
    analysis: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 7V5M5 7V2M8 7V4M11 7V3M14 7V5" stroke="currentColor" stroke-width="1.8"/><path d="M2 9v3M5 9v4M8 9v2M11 9v4M14 9v2" stroke="currentColor" stroke-width="1.8" opacity=".6"/></svg>',
    swap: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5 2v11M2.5 10.5L5 13l2.5-2.5M11 14V3M8.5 5.5L11 3l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    audio: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1 8h1M3 6v4M5 3v10M7 5v6M9 2v12M11 6v4M13 4v8M15 7v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
  };
  const NAMES = { art: 'Animated art', analysis: 'Analysed energy', audio: 'Audio waveform' };
  const BAR_CSS = `
  .wv-bar{position:absolute;inset:0;pointer-events:none;z-index:4;opacity:0;transition:opacity .15s ease}
  .wv-host:hover .wv-bar,.wv-bar:focus-within,.wv-bar.flash{opacity:1}
  .wv-g{position:absolute;right:5px;display:flex;flex-direction:column;gap:3px;pointer-events:auto}
  .wv-g.row{flex-direction:row}
  .wv-b{width:22px;height:22px;box-sizing:border-box;padding:0;border-radius:calc(5px*var(--round));display:flex;align-items:center;justify-content:center;cursor:pointer;
    border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 82%,transparent);color:var(--muted);backdrop-filter:blur(2px)}

  .wv-b:hover{color:var(--text);border-color:var(--amber-dim)}
  .wv-b.on{color:var(--amber);border-color:var(--amber)}
  .wv-b:disabled{opacity:.35;cursor:default}
  .wv-b:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
  .wv-sep{width:22px;height:1px;background:var(--line);margin:1px 0}
  .wv-menu{position:fixed;z-index:1000;min-width:210px;padding:4px;border:1px solid var(--line);border-radius:calc(8px*var(--round));background:var(--surface);
    box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:13px;display:flex;flex-direction:column}

  .wv-menu button{all:unset;padding:6px 10px;border-radius:calc(5px*var(--round));cursor:pointer;color:var(--text);white-space:nowrap}
  .wv-menu button:hover,.wv-menu button:focus-visible{background:var(--surface-2);color:var(--amber)}
  .wv-menu-h{padding:4px 10px 6px;color:var(--muted);font-size:12px}
  .wv-menu-sep{height:1px;background:var(--line);margin:4px 2px}
  .wv-input-row{display:flex;gap:6px;padding:2px 6px 4px}
  .wv-input input{width:96px;font:500 14px var(--mono,monospace);padding:5px 8px;border-radius:calc(5px*var(--round));border:1px solid var(--line);background:var(--surface-2);color:var(--text);outline:none}
  .wv-input input:focus{border-color:var(--amber)}
  .wv-input .wv-input-row button{padding:5px 12px;border:1px solid var(--line);color:var(--text)}
  /* warp: a handle on every bar line along the top of the scrolling view (paused); the fixed one amber; the one
     dragged lit, where it was dashed; what the drag does in a tip by it */
  .wv-handles{position:absolute;left:0;top:0;bottom:0;width:0;z-index:2;pointer-events:none}
  .wv-hl{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--amber);pointer-events:none}
  .wv-hl.hover{opacity:.75}
  .wv-hl.drag{box-shadow:0 0 8px var(--amber)}
  .wv-hdia{position:absolute;top:0;width:12px;margin-left:-6px;text-align:center;font-size:10px;line-height:12px;color:var(--amber);pointer-events:none}
  .wv-hl.ghost{width:0;margin-left:0;background:none;border-left:1px dashed color-mix(in srgb,var(--text) 50%,transparent)}
  .wv-htip{position:absolute;top:28px;z-index:6;padding:5px 9px;border-radius:calc(6px*var(--round));font-size:12px;white-space:nowrap;pointer-events:none;
    background:var(--surface-2);border:1px solid var(--amber);color:var(--text);box-shadow:0 8px 20px rgba(0,0,0,.4)}
  .wv-htip b{color:var(--amber);font-family:var(--mono,monospace);font-weight:600}
  .wv-g.row .wv-sep{width:1px;height:22px;margin:0 1px}
  /* the two regions of a panel */
  .wv-region{position:absolute;left:0;right:0;top:0;bottom:0;overflow:hidden}
  .wv-top{display:none;bottom:auto;height:var(--wv-split,66.667%)}
  .wv-top > canvas{width:100%;height:100%;display:block}
  .wv-strip{position:absolute;top:0;bottom:0;left:0;width:0;will-change:transform;pointer-events:none}
  .wv-past{position:absolute;top:0;bottom:0;left:0;width:50%;background:rgba(0,0,0,.18);pointer-events:none}
  :root[data-fade="light"] .wv-past{background:color-mix(in srgb,var(--screen) 50%,transparent)}
  /* the playhead: the accent colour, outlined, with a triangle at each end (the bar lines are neutral) */
  .wv-center{position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;background:var(--amber);pointer-events:none;
    box-shadow:0 0 0 1.5px var(--surface)}
  .wv-center::before,.wv-center::after{content:'';position:absolute;left:50%;transform:translateX(-50%);border:7px solid transparent}
  .wv-center::before{top:0;border-top:9px solid var(--amber);border-bottom:0}
  .wv-center::after{bottom:0;border-bottom:9px solid var(--amber);border-top:0}
  .wv-top:not(.wv-on) > :is(.wv-strip,.wv-past,.wv-center){display:none}
  /* the cue point on the whole track (the scrolling view draws its own) */
  .wv-cue{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--cue);pointer-events:none;z-index:2}
  .wv-cue::after{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);border:6px solid transparent;border-bottom:8px solid var(--cue);border-top:0}
  .wv-cue[hidden]{display:none}
  .wv-loop{position:absolute;top:0;bottom:0;pointer-events:none;z-index:2;background:color-mix(in srgb,var(--cue) 18%,transparent);
    border-left:2px solid var(--cue);border-right:2px solid var(--cue);box-sizing:border-box}
  .wv-loop[hidden]{display:none}
  .wv-srcs{position:absolute;inset:0;pointer-events:none;z-index:2}
  .wv-src{position:absolute;top:0;bottom:0;min-width:2px;background:color-mix(in srgb,var(--amber) 30%,transparent);border-top:2px solid color-mix(in srgb,var(--amber) 70%,transparent)}
  .wv-src.on{background:color-mix(in srgb,var(--amber) 55%,transparent);border-top-color:var(--amber);box-shadow:0 0 8px var(--amber);z-index:1}
  .wv-split > .wv-top{display:block}
  .wv-split > .wv-main{top:var(--wv-split,66.667%);border-top:1px solid var(--line)}
  /* swapped: the whole track above (2/3), the music around the playhead below (1/3) */
  .wv-split.wv-run-below > .wv-top{top:var(--wv-split,66.667%);bottom:0;height:auto;border-top:1px solid var(--line)}
  .wv-split.wv-run-below > .wv-main{top:0;bottom:calc(100% - var(--wv-split,66.667%));border-top:0}
  `;
  let cssDone = false;
  function addCss() {
    if (cssDone || typeof document === 'undefined') return;
    cssDone = true;
    const s = document.createElement('style'); s.textContent = BAR_CSS; document.head.appendChild(s);
  }

  // host: the panel (positioned). opts.available(type, region) -> true, or why not (a short sentence).
  // -> { update() }: call when the track or its data changes.
  function createBar(host, opts) {
    addCss();
    host.classList.add('wv-host');
    const bar = document.createElement('div');
    bar.className = 'wv-bar';
    const gTop = document.createElement('div'), gMain = document.createElement('div');
    gTop.className = 'wv-g'; gMain.className = 'wv-g';
    bar.append(gTop, gMain);
    host.appendChild(bar);
    const mk = (cls, html, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'wv-b ' + cls; b.innerHTML = html; b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      ['pointerdown', 'mousedown', 'dblclick'].forEach(ev => b.addEventListener(ev, e => e.stopPropagation()));
      return b;
    };
    const split = mk('wv-split-b', ICONS.split, '', () => set({ split: !settings.split }));
    const swap = mk('wv-swap-b', ICONS.swap, '', () => set({ runBelow: !settings.runBelow }));
    const typeBtns = region => TYPES.map(t => {
      const b = mk('wv-t', ICONS[t], NAMES[t], () => set({ [region]: t }));
      b.dataset.t = t;
      return b;
    });
    const topBtns = typeBtns('top'), mainBtns = typeBtns('main');
    const sep = () => Object.assign(document.createElement('div'), { className: 'wv-sep' });
    // the upper region gets the split and swap buttons, then its views; the lower one its views. Each group
    // is a column, or a row where the region is too short for one.
    function layout() {
      const H = host.clientHeight, sp = settings.split;
      const need = n => n * 22 + (n - 1) * 3;
      gTop.replaceChildren(); gMain.replaceChildren();
      gTop.style.display = '';
      if (sp) {
        const fr = (parseFloat(getComputedStyle(host).getPropertyValue('--wv-split')) || 66.667) / 100;   // (the UI style's share)
        const below = settings.runBelow, upH = H * fr, loH = H - upH;
        const [up, lo] = below ? [gMain, gTop] : [gTop, gMain];
        up.append(split, swap, sep(), ...(below ? mainBtns : topBtns));
        up.classList.toggle('row', upH - 10 < need(5) + 3);
        up.style.top = '5px';
        lo.append(...(below ? topBtns : mainBtns));
        lo.classList.toggle('row', loH - 8 < need(3));
        lo.style.top = Math.round(upH + Math.max(3, (loH - (lo.classList.contains('row') ? 22 : need(3))) / 2)) + 'px';
      } else {
        gTop.style.display = 'none';
        gMain.append(split, sep(), ...mainBtns);
        gMain.classList.toggle('row', H - 10 < need(4) + 3);
        gMain.style.top = '5px';
      }
    }
    function update() {
      const below = settings.runBelow;
      split.classList.toggle('on', settings.split);
      split.title = settings.split ? 'One view of the whole track' :
        below ? 'Split: the whole track above, the music around the playhead below' : 'Split: the music around the playhead above, the whole track below';
      swap.classList.toggle('on', below);
      swap.title = below ? 'Swap: the music around the playhead above (big), the whole track below' : 'Swap: the whole track above (big), the music around the playhead below';
      swap.setAttribute('aria-label', swap.title); split.setAttribute('aria-label', split.title);
      const mark = (btns, region) => btns.forEach(b => {
        const t = b.dataset.t, ok = opts.available ? opts.available(t, region) : true;
        b.disabled = ok !== true;
        b.classList.toggle('on', settings[region] === t);
        b.title = NAMES[t] + (region === 'top' ? ' (scrolling)' : settings.split ? ' (whole track)' : '') + (ok === true ? '' : ' · ' + ok);
      });
      mark(topBtns, 'top'); mark(mainBtns, 'main');
      layout();
    }
    if (root.ResizeObserver) new ResizeObserver(layout).observe(host);
    update();
    return { update, el: bar };
  }

  // the panel's regions: split or not, and which way round (the host: the panel, holding .wv-top and .wv-main)
  function layoutHost(host, split) {
    host.classList.toggle('wv-split', !!split);
    host.classList.toggle('wv-run-below', !!split && settings.runBelow);
  }
  // settings that only change how things are drawn (the panels redraw, nothing else changes)
  const DRAW_ONLY = ['zoom', 'zoomB', 'zoomLink', 'fullness', 'fill'];
  const drawOnly = changed => !!changed && changed.length > 0 && changed.every(k => DRAW_ONLY.includes(k));

  root.WaveView = {
    RATE, TYPES, ZOOM_MIN, ZOOM_MAX,
    computePeaks, peaksFromBytes, computeHits, hitsFromBytes, HIT_RATE, beatGrid, exactGrid, kickStart, pinGrid, gridBeatAt, gridTimeAt, gridLocal, gridSig, gridApart, pinStore, legacyApply, legacyPins, popMenu, popInput, closeMenu, layoutHost, drawOnly,
    ready, get settings() { return settings; }, get loaded() { return loaded; }, set, zoomBy, zoomOf,
    paintAudio, paintScroll, createScroller, scrollTimeAt, createBar, addCss, cueMark, loopMark, srcMarks
  };
})(typeof window !== 'undefined' ? window : self);
