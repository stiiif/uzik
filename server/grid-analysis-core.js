// Uzikext's grid analysis: a track's tempo, its beat grid and which beat is the 1, with a verdict on itself.
//
// One file for every place that works a grid out (the page's worker today; written so the sync server could
// run the same file, as it does energy-analysis-core.js). It takes what the waveform already has, the "hits"
// (1000 frames a second: the low end's attacks, the mids' and highs' attacks, the bass's level) and the
// "peaks" (150 a second: the loudness of the bass, mids and highs), and, when the sound itself is at hand,
// its low end (bassBand) for the bass's notes.
//
// The method, reasoned from how dance music is built, not tuned on any track:
//
//   1. The evidence. Every hit of the track, to the millisecond, in three families: kicks (attacks of the
//      low end), snares and claps (attacks with a body in the mids: a snare, a clap, a rim, a chord stab) and
//      hats (attacks in the highs alone).
//   2. The tempo, by explanation. The track is read in windows of 24 s. In each, the hits agree on a small
//      common step (found from the times between hits); every tempo that is a multiple of half that step is a
//      candidate, so a tempo comes with its half, its double, its 2/3 and its 3/2. A grid is laid for each
//      candidate and scored on how well it explains the drums: how many of its beats carry a kick or a snare,
//      how much of the kicks and snares fall on its beats, and whether kick beats and snare beats alternate
//      (the backbeat: snares on 2 and 4). The windows add up; a window without drums (a breakdown, a pad, a
//      silence) has nothing to score and says nothing.
//      Two conventions settle what the drums can't: a drum on every beat is the beat, even with a hit
//      between each (so not a tempo above 185 whose half has a drum on every beat); and under 88, a kick and
//      a snare alternating, or drums on only some of the beats, are half-time (the kick on 1, the snare on 3:
//      dubstep, trap, one-drop), counted double.
//   3. The exact grid. From the window the winning tempo explains best, every beat's own hit is found (its
//      start, by one rule) and a straight line fitted through them, then through twice as much of the track,
//      and again, to the whole of it: the tempo to about 0.001 BPM, the beats within a millisecond.
//   4. Constant tempo. Window by window again: where the drums play, how many beats have their hit on the
//      line. Where that falls under half of what the best window has, the line doesn't hold (the tempo
//      drifts, two takes at two speeds, the grid slips once): said, with the tempo of the start, the middle
//      and the end.
//   5. The whole-number lock. Music made on a computer is at a whole BPM, sometimes a half: when the fitted
//      tempo is within a hair of one (the grid would not move by more than a millisecond anywhere), it is
//      that one, exactly. Otherwise the tempo is kept as measured and noted as unusual (a vinyl rip, a band).
//   6. The 1. Four clues vote: the drum pattern (the kick is on the 1, the snare isn't), where the music
//      changes (a new section starts on a 1; a swell over two bars is not a change), where the bass line stops
//      repeating the bar before (the changed stretch lies inside one bar), and where the kick comes in after
//      an intro or a breakdown without it (on a 1).
//   7. Trust. Each step is checked a second, independent way: the tempo by its margin over the next best
//      explanation and by the windows agreeing with each other; the grid by how tightly the hits sit on the
//      line and by the windows' own count; the 1 by its clues agreeing. All agree: `ok`. Otherwise `why` says
//      what to check, in codes (reasonText puts them in words); `notes` say what is unusual but fine.
//
// analyzeGrid(peaks, hits, { bass }) -> {
//   v, bpm, period, t0 (a beat), bar0 (a 1: the grid is this anchor and the BPM), whole (locked on a whole or
//   half BPM), ok, why: [{ code, ... }], notes: [{ code, ... }], conf: { ... }, drift, parts, sections: [] }
// or { v, bpm: null, ok: false, why: [{ code: 'none' }] } when no steady beat is found.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GridAnalysisCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const GRID_V = 3;                        // the method's number: another, and every automatic grid is worked out again
  const HIT_RATE = 1000, PK_RATE = 150;
  const ROW_SHIFT = [0.0033, 0.0020];      // (as waveview.js: the rows' rise starts a little before the sound)
  const TOL = 0.015;                       // a hit within 15 ms of a beat is on it
  const WIN = 24, HOP = 12;                // the windows the tempo is read in, s
  const BPM_MIN = 60, BPM_MAX = 200;
  const HALFTIME_UNDER = 88, OFFBEAT_OVER = 185;   // the two conventions (see 2. above)
  
  // ---------- 1. the evidence ----------
  // The hits on a row of the hits data: where the row rises by at least `minRise` within 30 ms, the hit's start
  // (where the rise gets halfway up, between frames: the rule of the waveform's own kickStart) and its height.
  function rowOnsets(d, n, row, minRise) {
    const V = i => d[3 * i + row], T = [], S = [];
    let lo = 0;
    for (let i = 1; i < n; i++) {
      if (i - lo > 30) { lo = i - 30; for (let j = lo + 1; j < i; j++) if (V(j) < V(lo)) lo = j; }
      const v = V(i);
      if (v < V(lo)) { lo = i; continue; }
      if (v - V(lo) < minRise) continue;
      let top = i;
      for (let j = i + 1, e = Math.min(n - 1, i + 30); j <= e; j++) { const w = V(j); if (w > V(top)) top = j; else if (w < V(top) - 4) break; }
      const b0 = V(lo), h = b0 + 0.5 * (V(top) - b0);
      let t = top;
      for (let j = lo + 1; j <= top; j++) if (V(j) >= h) { const y0 = V(j - 1), y1 = V(j); t = j - 1 + (y1 > y0 ? (h - y0) / (y1 - y0) : 1); break; }
      // (a hit's body can rise again within 35 ms, a noisy tail too: the same hit, at its first start)
      const tt = t / HIT_RATE + ROW_SHIFT[row], m = T.length - 1;
      if (m >= 0 && tt - T[m] < 0.035) S[m] = Math.max(S[m], V(top) - b0);
      else { T.push(tt); S.push(V(top) - b0); }
      lo = top; i = top;
    }
    return { t: Float64Array.from(T), s: Float32Array.from(S) };
  }
  // the hit near t (s) on a row: its start, or null (waveview.js: kickStart, the same rule, so the grid sits
  // where the waveform draws the kick's front)
  function hitStart(hits, t, row, win) {
    const d = hits.data, n = hits.n, R = HIT_RATE, V = i => d[3 * i + row];
    const c = Math.round(t * R), a = Math.max(1, c - Math.round(win * R)), b = Math.min(n - 1, c + Math.round(win * R));
    if (b <= a) return null;
    let lo = a, M = 0;
    for (let i = a; i <= c; i++) if (V(i) < V(lo)) lo = i;
    for (let i = lo; i <= b; i++) if (V(i) > M) M = V(i);
    const base = V(lo);
    if (M - base < 24) return null;
    let lb = lo, i = lo + 1;
    for (; i <= b; i++) { if (V(i) < V(lb)) lb = i; if (V(i) >= base + 0.5 * (M - base)) break; }
    if (i > b) return null;
    let top = V(i), ti = i;
    for (let j = i + 1; j <= b; j++) { const v = V(j); if (v > top) { top = v; ti = j; } else if (v < top - 4) break; }
    const b0 = V(lb), h = b0 + 0.5 * (top - b0);
    for (let j = lb + 1; j <= ti; j++) if (V(j) >= h) { const y0 = V(j - 1), y1 = V(j); return (j - 1 + (y1 > y0 ? (h - y0) / (y1 - y0) : 1)) / R + ROW_SHIFT[row]; }
    return null;
  }
  const pct = (arr, p) => { if (!arr.length) return 0; const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  // the first index of a sorted array at or after t
  function lower(T, t) { let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; }
  // the index of the hit of T nearest to t within tol, or -1
  function near(T, t, tol) {
    const i = lower(T, t);
    let b = -1, bd = tol;
    if (i < T.length && T[i] - t <= bd) { b = i; bd = T[i] - t; }
    if (i > 0 && t - T[i - 1] <= bd) b = i - 1;
    return b;
  }

  // The three families, each hit with a weight from 0 to 1.
  //   A kick: a hit of the low row. Its weight is its height against the track's strong low hits, squared: a
  //   bass note's softer attack counts for little beside a kick, and the beat is carried by the strongest.
  //   A snare (or a clap, a rim, a chord stab): a hit of the upper row with a body in the mids (how much the
  //   mids' loudness rises with it, from the peaks). A kick has mids and a click of its own: what a kick alone
  //   adds (the least of the hits that come with a kick) is taken off, so a clap on a kick still counts and a
  //   bare kick doesn't.
  //   A hat: a hit of the upper row with no body, only highs.
  function findEvents(hits, peaks) {
    const K = rowOnsets(hits.data, hits.n, 0, 24), S = rowOnsets(hits.data, hits.n, 1, 24);
    const pd = peaks.data, pn = peaks.n;
    const rise = (t, o) => {
      const f = Math.floor(t * PK_RATE);
      let be = 255, af = 0;
      for (let j = f - 2; j <= f - 1; j++) if (j >= 0 && j < pn) be = Math.min(be, pd[4 * j + o]);
      for (let j = f; j <= f + 3; j++) if (j >= 0 && j < pn) af = Math.max(af, pd[4 * j + o]);
      return be === 255 ? 0 : Math.max(0, af - be);
    };
    const refK = pct(K.s, 0.9), nK = K.t.length, nS = S.t.length;
    const kw = new Float32Array(nK);
    for (let i = 0; i < nK; i++) { const r = refK > 0 ? K.s[i] / refK : 0; kw[i] = r >= 0.3 ? Math.min(1, r * r) : 0; }
    const refR = pct(S.s, 0.9);
    // withK: how much of a kick comes with this hit (0: none; 1: a full kick; between: a soft kick or a bass note)
    const body = new Float32Array(nS), air = new Float32Array(nS), withK = new Float32Array(nS);
    const wk = [], wa = [];
    for (let i = 0; i < nS; i++) {
      body[i] = rise(S.t[i], 2); air[i] = rise(S.t[i], 3);
      const k = near(K.t, S.t[i], 0.012);
      withK[i] = k >= 0 && kw[k] >= 0.3 ? Math.min(1, kw[k] / 0.64) : 0;
      // (what a kick alone adds, from the hits that are loud on the upper row as a kick's click is: a hat
      // over a bass note isn't)
      if (withK[i] && S.s[i] >= 0.5 * refR) { wk.push(body[i]); wa.push(air[i]); }
    }
    const kBody = wk.length >= 8 ? pct(wk, 0.25) : 0, kAir = wa.length >= 8 ? pct(wa, 0.25) : 0;
    // (on a full kick, the kick's own mids are often the loudest there are: what comes with it shows in the
    // mids or in the highs, over the kick's own)
    for (let i = 0; i < nS; i++) if (withK[i]) body[i] = Math.max(0, body[i] - withK[i] * kBody) + (withK[i] >= 0.9 ? Math.max(0, air[i] - kAir) : 0);
    // (a snare is a real hit: a pad's slow beating moves the mids too, with next to nothing on the hits' row)
    for (let i = 0; i < nS; i++) if (S.s[i] < 0.3 * refR) { air[i] = Math.max(air[i], body[i]); body[i] = 0; }
    const refB = pct(Array.from(body).filter(v => v >= 15), 0.9), thB = Math.max(30, 0.35 * refB);
    const sw = new Float32Array(nS), hw = new Float32Array(nS);
    for (let i = 0; i < nS; i++) {
      if (body[i] >= thB) { const r = body[i] / refB; sw[i] = Math.min(1, r * r); }
      else if (!withK[i]) hw[i] = Math.min(1, Math.max(air[i], 0.5 * S.s[i]) / 255);
    }
    // the drums, in time order (the kicks and snares that count), and every hit with what it weighs
    const drums = [], all = [];
    for (let i = 0; i < nK; i++) { all.push([K.t[i], Math.max(kw[i], 0.1 * K.s[i] / 255)]); if (kw[i] >= 0.3) drums.push(K.t[i]); }
    for (let i = 0; i < nS; i++) { all.push([S.t[i], Math.max(sw[i], 0.25 * S.s[i] / 255)]); if (sw[i] >= 0.3) drums.push(S.t[i]); }
    drums.sort((a, b) => a - b); all.sort((a, b) => a[0] - b[0]);
    // running sums of the weights, for "how much of the drums is between two times"
    const cum = w => { const c = new Float64Array(w.length + 1); for (let i = 0; i < w.length; i++) c[i + 1] = c[i] + w[i]; return c; };
    return { Kt: K.t, Ks: K.s, kw, St: S.t, Ss: S.s, body, sw, hw, cumK: cum(kw), cumS: cum(sw), drums: Float64Array.from(drums),
      allT: Float64Array.from(all.map(e => e[0])), allW: Float32Array.from(all.map(e => e[1])), kicks: kw.filter(v => v >= 0.36).length, snares: sw.filter(v => v > 0).length, hats: hw.filter(v => v > 0).length };
  }

  // ---------- 2. the tempo, by explanation ----------
  // The common step of the hits between t0 and t1: the largest step that the times between hits are multiples
  // of (from their histogram, then exactly where the hits line up best, then a straight line through them).
  // -> { q (s), a (a time on the step) } or null (too few hits, or no regularity).
  function stepOf(ev, t0, t1) {
    const i0 = lower(ev.allT, t0), i1 = lower(ev.allT, t1), T = ev.allT, W = ev.allW;
    if (i1 - i0 < 12) return null;
    const H = new Float32Array(2002);
    let tot = 0;
    for (let i = i0; i < i1; i++) for (let j = i + 1; j < i1; j++) { const dt = T[j] - T[i]; if (dt > 2) break; const w = W[i] * W[j]; H[Math.round(dt * 1000)] += w; tot += w; }
    if (!(tot > 0)) return null;
    // how well the times between hits are multiples of a step q: 1 when they all are, about 0 for any other
    const lags = []; for (let l = 20; l <= 2000; l++) if (H[l]) lags.push(l);
    const F = q => { let s = 0; const w = 2 * Math.PI / 1000 / q; for (const l of lags) s += H[l] * Math.cos(l * w); return s / tot; };
    // every step from 55 to 500 ms: the largest that does nearly as well as the best (a step's halves and
    // thirds do as well as it; its doubles don't)
    const N = 891, f = new Float32Array(N);
    let fmax = 0;
    for (let i = 0; i < N; i++) { f[i] = F(0.055 + i * 0.0005); if (f[i] > fmax) fmax = f[i]; }
    if (fmax < 0.15) return null;
    let q = 0;
    for (let i = N - 2; i > 0; i--) if (f[i] >= 0.8 * fmax && f[i] >= f[i - 1] && f[i] >= f[i + 1]) { q = 0.055 + i * 0.0005; break; }
    if (!q) return null;
    // exactly: where the hits line up best around it (their resultant), then the line through them
    const span = Math.max(4, T[i1 - 1] - T[i0]);
    const res = qq => { let x = 0, y = 0; const w = 2 * Math.PI / qq; for (let i = i0; i < i1; i++) { const a = (T[i] - t0) * w; x += W[i] * Math.cos(a); y += W[i] * Math.sin(a); } return { r: x * x + y * y, ph: Math.atan2(y, x) }; };
    let best = { q, ...res(q) };
    const step = q * q / span * 0.2;
    for (let k = -40; k <= 40; k++) { const qq = q + k * step, r = res(qq); if (r.r > best.r) best = { q: qq, ...r }; }
    for (let k = -8; k <= 8; k++) { const qq = best.q + k * step / 10, r = res(qq); if (r.r > best.r) best = { q: qq, ...r }; }
    q = best.q;
    let a = t0 + ((best.ph / (2 * Math.PI)) * q + q) % q;
    for (const lim of [0.012, 0.006, 0.004]) {
      let sk = 0, st = 0, skk = 0, skt = 0, m = 0;
      for (let i = i0; i < i1; i++) { if (W[i] < 0.3) continue; const k = Math.round((T[i] - a) / q), e = T[i] - (a + k * q); if (Math.abs(e) > Math.min(lim, 0.3 * q)) continue; sk += k; st += T[i]; skk += k * k; skt += k * T[i]; m++; }
      if (m < 10 || m * skk - sk * sk === 0) break;
      const slope = (m * skt - sk * st) / (m * skk - sk * sk);
      if (!(slope > 0) || Math.abs(slope / q - 1) > 0.01) break;
      q = slope; a = (st - slope * sk) / m;
    }
    return { q, a };
  }

  // A grid of beats (a + i·P) between t0 and t1, scored on how well it explains the drums there:
  //   c    the share of its beats (where the drums play) that carry a kick or a snare
  //   e    the share of the kicks and snares that fall on its beats
  //   alt  the backbeat: kicks on every other beat and not between, snares between and not on them (0 to 1)
  //   cK   the share of its beats that carry a kick (four-to-the-floor: near 1)
  // (shares of weight: a full kick counts 1, a soft low hit a little)
  // score = c · e · (1 + alt). `even`: which beats are the kick beats (0 or 1: i's parity).
  function scoreGrid(ev, a, P, t0, t1) {
    const iA = Math.ceil((t0 - a) / P - 1e-9), iB = Math.floor((t1 - a) / P + 1e-9);
    let nAct = 0, nPres = 0, nK = 0, onK = 0, onS = 0;
    const nPar = [0, 0], kPar = [0, 0], sPar = [0, 0];
    const rad = Math.max(1.3, 1.6 * P);
    for (let i = iA; i <= iB; i++) {
      const b = a + i * P;
      const d = lower(ev.drums, b - rad);
      if (!(d < ev.drums.length && ev.drums[d] <= b + rad)) continue;     // (no drums around: says nothing)
      const ki = near(ev.Kt, b, TOL), si = near(ev.St, b, TOL);
      const k = ki >= 0 ? ev.kw[ki] : 0, s = si >= 0 ? ev.sw[si] : 0, p = ((i % 2) + 2) % 2;
      nAct++; nPar[p]++;
      nPres += Math.max(k, s); nK += k; kPar[p] += k;
      onK += k; onS += s; sPar[p] += s;
    }
    if (nAct < 8) return null;
    const totK = ev.cumK[lower(ev.Kt, t1)] - ev.cumK[lower(ev.Kt, t0)], totS = ev.cumS[lower(ev.St, t1)] - ev.cumS[lower(ev.St, t0)];
    if (!(totK + totS > 0)) return null;
    const c = nPres / nAct, e = Math.min(1, (onK + onS) / (totK + totS));
    let alt = 0, even = 0;
    for (const p of [0, 1]) {
      const o = 1 - p, sO = nPar[o] ? sPar[o] / nPar[o] : 0, sE = nPar[p] ? sPar[p] / nPar[p] : 0;
      const kE = nPar[p] ? kPar[p] / nPar[p] : 0, kO = nPar[o] ? kPar[o] / nPar[o] : 0;
      const v = Math.max(0, kE - kO) * Math.max(0, (sO - sE) / (sO + sE + 0.05));
      if (v > alt) { alt = v; even = p; }
    }
    return { score: c * e * (1 + alt), c, e, alt, cK: nK / nAct, even, w: totK + totS };
  }

  // One window's reading: every candidate tempo (the multiples of half the hits' common step, 60 to 200 BPM)
  // with its best grid.
  function readWindow(ev, t0, t1) {
    if (lower(ev.drums, t1) - lower(ev.drums, t0) < 12) return null;
    const st = stepOf(ev, t0, t1);
    if (!st) return null;
    const h = st.q / 2, out = [];
    for (let m = Math.ceil(60 / BPM_MAX / h - 1e-6); m * h <= 60 / BPM_MIN + 1e-6; m++) {
      const P = m * h;
      let best = null;
      for (let j = 0; j < m; j++) {
        const s = scoreGrid(ev, st.a + j * h, P, t0, t1);
        if (s && (!best || s.score > best.score)) best = { ...s, a: st.a + j * h };
      }
      if (best) out.push({ ...best, P, bpm: 60 / P, t0, t1, h, aq: st.a });
    }
    return out.length ? out : null;
  }

  // ---------- the bass's notes (when the sound is at hand) ----------
  // The low end of the sound (under 140 Hz), at about 2000 samples a second, as 16-bit numbers: what the
  // bass's notes are read from. samples: Float32Array (one channel, or the two mixed).
  function bassBand(samples, sr) {
    const dec = Math.max(1, Math.floor(sr / 2000)), rate = sr / dec, n = Math.floor(samples.length / dec);
    const w = 2 * Math.PI * 140 / sr, cw = Math.cos(w), al = Math.sin(w) / Math.SQRT2, a0 = 1 + al;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    const out = new Float32Array(n);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0, top = 0;
    for (let i = 0, o = 0; o < n; i++) {
      const x = samples[i], y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const v = b0 * y + b1 * u1 + b0 * u2 - a1 * v1 - a2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      if (i % dec === dec - 1) { out[o++] = v; const av = v < 0 ? -v : v; if (av > top) top = av; }
    }
    const data = new Int16Array(n), g = top > 0 ? 32000 / top : 0;
    for (let i = 0; i < n; i++) data[i] = Math.round(out[i] * g);
    return { rate, data };
  }
  // the bass's note over each beat (Hz; 0: none, too quiet or no clear pitch): the pitch (32 to 130 Hz) the
  // low end repeats at best over the beat's second half (past the kick and its own falling pitch)
  function bassNotes(band, beatT) {
    const R = band.rate, d = band.data, n = d.length, out = new Float32Array(beatT.length);
    const lmin = Math.floor(R / 130), lmax = Math.ceil(R / 32), en = new Float32Array(beatT.length);
    const seg = new Float32Array(Math.ceil(R * 1.2));
    for (let b = 0; b + 1 < beatT.length; b++) {
      const i0 = Math.round((beatT[b] + beatT[b + 1]) / 2 * R), i1 = Math.min(n, Math.round(beatT[b + 1] * R), i0 + seg.length);
      const m = i1 - i0;
      if (i0 < 0 || m < 3 * lmax) continue;
      let e0 = 0;
      for (let i = 0; i < m; i++) { seg[i] = d[i0 + i]; e0 += seg[i] * seg[i]; }
      en[b] = e0 / m;
      if (!(e0 > 0)) continue;
      const ac = l => { let s = 0, ea = 0, eb = 0; for (let i = 0; i + l < m; i++) { s += seg[i] * seg[i + l]; ea += seg[i] * seg[i]; eb += seg[i + l] * seg[i + l]; } return s / (Math.sqrt(ea * eb) + 1e-9); };
      let bl = 0, bv = 0;
      for (let l = lmin; l <= lmax; l++) { const v = ac(l); if (v > bv + 0.02) { bv = v; bl = l; } }   // (the shortest of equal periods: the note, not its octave below)
      if (bv < 0.7 || bl <= lmin || bl >= lmax) continue;
      const y0 = ac(bl - 1), y2 = ac(bl + 1), den = y0 - 2 * bv + y2;
      out[b] = R / (bl + (den < 0 ? 0.5 * (y0 - y2) / den : 0));
    }
    const ref = pct(Array.from(en).filter(v => v > 0), 0.8);
    for (let b = 0; b < out.length; b++) if (en[b] < 0.05 * ref) out[b] = 0;
    return out;
  }

  // the number of the beat in the middle of a window, on a line
  const kSeedOf = (icpt, period, w) => Math.round(((w.t0 + w.t1) / 2 - icpt) / period);

  // ---------- the whole analysis ----------
  function analyzeGrid(peaks, hits, opts = {}) {
    if (!hits || !hits.data || hits.rate !== HIT_RATE || !peaks || !peaks.data || hits.n < 8 * HIT_RATE) return null;
    const dur = hits.n / HIT_RATE, none = code => ({ v: GRID_V, bpm: null, ok: false, why: [{ code }], notes: [], sections: [] });
    const ev = findEvents(hits, peaks);
    if (ev.drums.length < 24) return none(opts.debug ? 'none:drums' : 'none');

    // -- 2. the windows' readings, added up by tempo
    const wins = [];
    for (let t0 = 0; t0 < Math.max(1, dur - WIN / 2); t0 += HOP) { const r = readWindow(ev, t0, Math.min(dur, t0 + WIN)); if (r) wins.push(r); }
    if (!wins.length) return none(opts.debug ? 'none:windows' : 'none');
    const clusters = [];
    let wAll = 0;
    for (const w of wins) {
      wAll += w[0].w;
      for (const c of w) {
        let cl = clusters.find(x => Math.abs(Math.log(c.bpm / x.bpm)) < 0.012);
        if (!cl) { cl = { bpm: c.bpm, sum: 0, wsum: 0, cK: 0, c: 0, alt: 0, list: [] }; clusters.push(cl); }
        cl.bpm = (cl.bpm * cl.wsum + c.bpm * c.w) / (cl.wsum + c.w);
        cl.sum += c.score * c.w; cl.cK += c.cK * c.w; cl.c += c.c * c.w; cl.alt += c.alt * c.w; cl.wsum += c.w; cl.list.push(c);
      }
    }
    for (const cl of clusters) { cl.agg = cl.sum / wAll; cl.cK /= cl.wsum; cl.c /= cl.wsum; cl.alt /= cl.wsum; }
    clusters.sort((x, y) => y.agg - x.agg);
    let pick = clusters[0];
    if (!(pick.agg > 0.12)) return none(opts.debug ? 'none:score ' + pick.agg : 'none');
    const notes = [], why = [];
    const partner = f => clusters.find(x => Math.abs(Math.log(x.bpm / (pick.bpm * f))) < 0.012);
    // (the first convention: a drum on every beat is the beat, even when an offbeat stab makes the double look
    // like kick, snare, kick, snare)
    const bestOf = cl => cl.list.reduce((x, y) => (y.score > x.score ? y : x));
    if (pick.bpm > OFFBEAT_OVER) { const half = partner(0.5); if (half && bestOf(half).c >= 0.85) { pick = half; notes.push({ code: 'offbeat' }); } }
    const raw = clusters[0];
    // the windows, each on its own: do they read the same tempo?
    let agree = 0, voters = 0;
    const partsOf = [[], [], []];
    for (const w of wins) {
      const b = w.reduce((x, y) => (y.score > x.score ? y : x));
      if (b.score < 0.4) continue;
      voters++;
      const same = Math.abs(Math.log(b.bpm / raw.bpm)) < 0.012;
      if (same) agree++;
      partsOf[Math.min(2, Math.floor(((b.t0 + b.t1) / 2) / dur * 3))].push(same ? 0 : b.bpm);
    }
    // the seed: the window that the winning tempo explains best
    const seed = bestOf(pick);
    let P = seed.P, a = seed.a + seed.even * seed.P;         // (a: a kick beat)
    const Pp = seed.P;
    // (the second convention: kick and snare alternating slower than 88, with no kick on every beat: half-time.
    // But a drum of one kind on every beat is the beat, as above: under a loud held bass a kick's low end
    // hardly shows, and a slow four-to-the-floor reads as a "snare" on every beat)
    let halftime = false;
    if (pick.bpm < HALFTIME_UNDER && seed.cK < 0.85 && (seed.alt >= 0.25 || seed.c < 0.75)) { P /= 2; halftime = true; notes.push({ code: 'halftime' }); }
    // the next best explanation (not the one the conventions just chose between: a tempo and its own double)
    const second = clusters.find(x => x !== raw && x !== pick && !(halftime && Math.abs(Math.log(x.bpm / (pick.bpm * 2))) < 0.012)) || null;
    const margin = second && second.agg > 0 ? raw.agg / second.agg : 9;

    // -- 3. the exact grid: each beat's own hit on a row of the hits, by the one rule (hitStart), and the
    // straight line through them. Grown from the seed window, where the line is known to a millisecond: fitted
    // there, then on twice as much of the track, and again, to the whole of it.
    const kLo = Math.ceil((0 - a) / P) - 2, kHi = Math.floor((dur - a) / P) + 2, nB = kHi - kLo + 1;
    if (nB < 16) return none('none');
    const lineOf = row => {
      let icpt = a, slope = P, got = null;
      const fit = (ks, ts, use) => {
        let sk = 0, st = 0, skk = 0, skt = 0, m = 0;
        for (let i = 0; i < ks.length; i++) if (use[i]) { sk += ks[i]; st += ts[i]; skk += ks[i] * ks[i]; skt += ks[i] * ts[i]; m++; }
        if (m < 12 || m * skk - sk * sk === 0) return null;
        const sl = (m * skt - sk * st) / (m * skk - sk * sk);
        return sl > 0 ? { slope: sl, icpt: (st - sl * sk) / m, m } : null;
      };
      for (let ext = 0, last = false; !last; ext = ext ? ext * 2 : WIN) {
        const ta = seed.t0 - ext, tb = seed.t1 + ext;
        last = ta <= 0 && tb >= dur;
        const ks = [], ts = [];
        for (let k = kLo; k <= kHi; k++) { const b = icpt + k * slope; if (b < Math.max(0, ta) || b > Math.min(dur, tb)) continue; const t = hitStart(hits, b, row, 0.025); if (t != null) { ks.push(k); ts.push(t); } }
        let use = ks.map(() => true), r = fit(ks, ts, use);
        if (!r) { if (last) break; continue; }
        for (const lim of [0.006, 0.003, 0.002]) {
          const u = ks.map((k, i) => Math.abs(ts[i] - (r.icpt + r.slope * k)) < lim), r2 = fit(ks, ts, u);
          if (!r2) break;
          use = u; r = r2;
        }
        if (Math.abs(r.slope / P - 1) > 0.01) break;
        icpt = r.icpt; slope = r.slope; got = { ks, ts, use, fit: r };
      }
      if (!got || got.fit.m < 16) return null;
      let ss = 0, on = 0;
      for (let i = 0; i < got.ks.length; i++) { const e = got.ts[i] - (icpt + slope * got.ks[i]); if (got.use[i]) ss += e * e; if (Math.abs(e) < 0.002) on++; }
      return { row, ks: got.ks, ts: got.ts, fit: got.fit, on: on / got.ks.length, kicks: got.fit.m / (got.ks[got.ks.length - 1] - got.ks[0] + 1), rms: Math.sqrt(ss / got.fit.m) * 1000 };
    };
    const lines = [lineOf(1), lineOf(0)].filter(Boolean);
    if (!lines.length) return { ...none('few'), bpm: Math.round(60 / P * 100) / 100 };
    const L = lines.sort((x, y) => (y.kicks - 0.15 * y.rms) - (x.kicks - 0.15 * x.rms))[0];
    let period = L.fit.slope, icpt = L.fit.icpt;

    // -- 4. constant tempo? A second, independent look, window by window. Where the windows read this tempo
    // (the passages with drums), how many of the line's beats have their hit on it (within 2 ms), against
    // the seed window's own count. A window with less than half the seed's share: the line doesn't hold
    // there (the tempo has drifted away, or the grid has slipped: an edit, a record skipping).
    let drift = null, parts = null;
    {
      const onLine = new Set();
      for (let i = 0; i < L.ks.length; i++) if (Math.abs(L.ts[i] - (icpt + period * L.ks[i])) < 0.002) onLine.add(L.ks[i]);
      const shareOf = w => {
        let nA = 0, nO = 0;
        for (let k = Math.ceil((w.t0 - icpt) / period); icpt + k * period < w.t1; k++) {
          const b = icpt + k * period, d = lower(ev.drums, b - 1.5);
          if (!(d < ev.drums.length && ev.drums[d] <= b + 1.5)) continue;
          nA++; if (onLine.has(k)) nO++;
        }
        return nA >= 8 ? nO / nA : null;
      };
      const ref = shareOf(seed), good = pick.list.filter(c => c.score >= 0.3 * seed.score), bad = [];
      if (ref) for (const w of good) { const r = shareOf(w); if (r != null && r < 0.5 * ref) bad.push(w); }
      if (bad.length >= 2) {
        const mid = w => (w.t0 + w.t1) / 2, sm = mid(seed), near1 = bad.reduce((x, y) => (Math.abs(mid(y) - sm) < Math.abs(mid(x) - sm) ? y : x));
        const at = Math.round(mid(near1) > sm ? near1.t0 + HOP / 2 : near1.t1 - HOP / 2);
        // the tempo of the start, the middle and the end, each from its own windows
        const mul = P / Pp;
        parts = [0, 1, 2].map(p3 => { const b = good.filter(c => Math.min(2, Math.floor(mid(c) / dur * 3)) === p3).map(c => c.bpm / mul).sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1] * 100) / 100 : null; });
        const known = parts.filter(Boolean), jump = known.length >= 2 && (Math.max(...known) - Math.min(...known)) / known[0] < 0.0007;
        drift = { kind: jump ? 'jump' : 'wander', at, windows: bad.length };
        why.push({ code: jump ? 'jump' : 'drift', at, parts });
        // (the tempo then: the windows' own, all of them; the grid: the line as grown, right around the seed)
        if (!jump) { const mean = 60 / (pick.bpm / mul), ks = kSeedOf(icpt, period, seed); icpt += ks * (period - mean); period = mean; }
      }
    }

    // -- 5. the whole-number lock
    let whole = false;
    const fitBpm = 60 / period;
    if (!drift) {
      const r = Math.round(fitBpm * 2) / 2, span = L.ks[L.ks.length - 1] - L.ks[0], fit0 = { icpt, slope: period };
      if (Math.abs(60 / r - period) * span / 2 <= 0.001) {
        // (the same hits, the line's slope fixed at the whole tempo)
        const pr = 60 / r; let s = 0, m = 0;
        for (let i = 0; i < L.ks.length; i++) { const e = L.ts[i] - (fit0.icpt + fit0.slope * L.ks[i]); if (Math.abs(e) < 0.002) { s += L.ts[i] - pr * L.ks[i]; m++; } }
        if (m) { period = pr; icpt = s / m; whole = true; }
      }
      if (!whole) notes.push({ code: 'nonwhole', bpm: Math.round(fitBpm * 100) / 100 });
    }
    // the beats: beat k (as counted from the seed) at beatT(k); on the line when the tempo is constant
    const beatT = k => icpt + k * period;

    // -- 6. the 1
    const one = findOne(ev, peaks, opts.bass, beatT, kLo, kHi);
    const t0 = icpt - Math.floor(icpt / period) * period;
    const bar0 = icpt + one.k1 * period;

    // -- 7. trust
    if (margin < 1.15 && second) why.push({ code: 'tempo2', bpm: Math.round(second.bpm * 10) / 10 });
    if (voters >= 3 && agree / voters < 0.6) {
      const names = ['start', 'middle', 'end'];
      const odd = partsOf.map((p, i) => { const d = p.filter(Boolean); return d.length > p.length / 2 ? { part: names[i], bpm: Math.round(d.sort((x, y) => x - y)[d.length >> 1] * 10) / 10 } : null; }).filter(Boolean);
      why.push({ code: 'parts', odd });
    }
    if (L.fit.m < 24) why.push({ code: 'few', n: L.fit.m });
    if (!drift && (L.rms > 1.5 || L.on < 0.5)) why.push({ code: 'loose', ms: Math.round(L.rms * 10) / 10, on: Math.round(L.on * 100) });
    if (!one.ok) why.push({ code: 'one', by: one.by });
    const conf = { kicks: Math.round(L.kicks * 1000) / 1000, rms: Math.round(L.rms * 100) / 100, row: L.row, on: Math.round(L.on * 1000) / 1000, n: L.fit.m,
      margin: Math.round(Math.min(9, margin) * 100) / 100, agree: voters ? Math.round(agree / voters * 100) / 100 : null, score: Math.round(raw.agg * 100) / 100, bar: one.conf };
    const out = { v: GRID_V, bpm: 60 / period, period, t0, bar0, whole, exact: true, ok: !why.length, why, notes, conf, drift, parts,
      families: { kicks: ev.kicks, snares: ev.snares, hats: ev.hats }, sections: [] };
    // (for the test bench's close look: what was weighed)
    if (opts.debug) out.dbg = { clusters: clusters.map(c => ({ bpm: c.bpm, agg: c.agg, cK: c.cK, c: c.c, alt: c.alt, n: c.list.length })), seed: { bpm: seed.bpm, a: seed.a, t0: seed.t0, score: seed.score, c: seed.c, e: seed.e, alt: seed.alt, even: seed.even },
      lines: lines.map(l => ({ row: l.row, n: l.ks.length, m: l.fit.m, rms: l.rms, kicks: l.kicks, on: l.on })) };
    return out;
  }

  // ---------- 6. which beat is the 1 ----------
  // Four clues, each giving the four beats of the bar a vote:
  //   the pattern   the kick is on the 1 (and, less, on the 3); a snare isn't on the 1 or the 3
  //   the changes   where the music changes (the bass, mids and highs over the 4 beats after a beat against the
  //                 4 before), a new section starts: on a 1
  //   the bass      where the bass line is not what it was a bar before: the changed stretch is inside one bar
  //   the entries   where the kick comes in after 16 beats or more without it: on a 1
  // A clue with nothing to say (no snare and a kick everywhere; fewer than 3 changes; one bass note; no entry) stays
  // out. The most voted beat is the 1; sure when it wins clearly and no clue with a clear opinion says otherwise.
  function findOne(ev, peaks, bass, beatT, kLo, kHi) {
    const nB = kHi - kLo + 1, T = new Float64Array(nB + 1);
    for (let i = 0; i <= nB; i++) T[i] = beatT(kLo + i);
    const mod4 = k => ((k % 4) + 4) % 4;
    const clues = [];
    // the pattern
    let first = null;
    {
      const kp = [0, 0, 0, 0], sp = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
      for (let i = 0; i < nB; i++) {
        const b = T[i], d = lower(ev.drums, b - 1.5);
        if (!(d < ev.drums.length && ev.drums[d] <= b + 1.5)) continue;
        const ki = near(ev.Kt, b, TOL), si = near(ev.St, b, TOL), r = mod4(kLo + i);
        const k = ki >= 0 ? ev.kw[ki] : 0;
        if (k >= 0.36 && first == null) first = kLo + i;
        cnt[r]++; kp[r] += k; sp[r] += si >= 0 ? ev.sw[si] : 0;
      }
      for (let r = 0; r < 4; r++) { kp[r] /= cnt[r] || 1; sp[r] /= cnt[r] || 1; }
      const smin = Math.min(...sp), smax = Math.max(...sp), s = sp.map(v => (smax - smin > 0.15 ? (v - smin) / (smax - smin) : 0));
      // (with a snare on 2 and on 4, a kick on only one of the other two beats is the 1 in most music and the
      // 3 in a one-drop: it then counts for less, and the other clues decide)
      const v = [0, 1, 2, 3].map(r => { const bb = Math.min(s[(r + 1) % 4], s[(r + 3) % 4]); return Math.max(0, (2 - bb) * kp[r] + 0.5 * kp[(r + 2) % 4] - 2 * s[r] - 0.5 * s[(r + 2) % 4] + 0.25 * (s[(r + 1) % 4] + s[(r + 3) % 4])); });
      clues.push({ name: 'pattern', v, kp: kp.map(x => Math.round(x * 100) / 100), sp: sp.map(x => Math.round(x * 100) / 100) });
    }
    if (first == null) first = kLo;
    // the changes
    {
      const d = peaks.data, n = peaks.n, F = [];
      for (let i = 0; i < nB; i++) {
        const fa = Math.max(0, Math.floor(T[i] * PK_RATE)), fb = Math.min(n, Math.floor(T[i + 1] * PK_RATE));
        let s1 = 0, s2 = 0, s3 = 0;
        for (let f = fa; f < fb; f++) { s1 += d[4 * f + 1]; s2 += d[4 * f + 2]; s3 += d[4 * f + 3]; }
        const c = Math.max(1, fb - fa);
        F.push([s1 / c, s2 / c, s3 / c]);
      }
      const nov = new Float64Array(nB);
      // (the bar after against the bar before, and against the bar before that too: a sound that rises and
      // falls over two bars, a swell, a filter opening and closing, makes the bar after unlike the one just
      // before at every other bar line and at every half bar, but like the one two bars back, where it was at
      // the same point of its rise and fall. A new section is unlike both)
      for (let k = 8; k < nB - 4; k++) {
        let v1 = 0, v2 = 0;
        for (let band = 0; band < 3; band++) {
          let be = 0, b2 = 0, af = 0;
          for (let j = 1; j <= 4; j++) { be += F[k - j][band]; b2 += F[k - 4 - j][band]; af += F[k + j - 1][band]; }
          v1 += Math.abs(af - be) / (af + be + 32);
          v2 += Math.abs(af - b2) / (af + b2 + 32);
        }
        nov[k] = Math.min(v1, v2);
      }
      const sorted = Array.from(nov.slice(8, Math.max(8, nB - 4))).sort((x, y) => x - y);
      const med = sorted.length ? sorted[sorted.length >> 1] : 0;
      const mad = sorted.length ? sorted.map(v => Math.abs(v - med)).sort((x, y) => x - y)[sorted.length >> 1] : 0;
      const v = [0, 0, 0, 0];
      let nP = 0;
      for (let k = 8; k < nB - 4; k++) {
        if (nov[k] < med + 2 * mad || nov[k] < 0.12) continue;
        let top = true;
        for (let j = k - 4; j <= k + 4; j++) if (j !== k && nov[j] > nov[k]) { top = false; break; }
        if (top) { v[mod4(kLo + k)] += nov[k]; nP++; }
      }
      clues.push({ name: 'changes', v: nP >= 3 ? v : [0, 0, 0, 0], n: nP });
    }
    // the bass's notes
    if (bass && bass.data && bass.data.length) {
      const f = bassNotes(bass, T), v = [0, 0, 0, 0];
      // Where the bass line is not what it was a bar before, beat for beat: a stretch of changed beats (the
      // line has moved on) lies inside one bar, so the bar starts between the stretch's last beat less 3 and
      // its first. Each such stretch votes for the beats that can be the 1. (Beat by beat against the bar
      // before, so a kick's own pitch, the same in every bar, never counts as a change.)
      let nV = 0;
      const diff = i => { if (i < 4 || !f[i] || !f[i - 4]) return -1; const d = Math.abs(12 * Math.log2(f[i] / f[i - 4])); return d >= 0.7 && Math.abs(d - 12) >= 0.7 ? 1 : 0; };
      for (let i = 4; i < nB; i++) {
        if (diff(i) !== 1) continue;
        let e = i, clean = false;
        for (let j = i + 1; j < nB && j - i < 6; j++) { const dj = diff(j); if (dj === 1) e = j; else if (dj === 0) { clean = true; break; } }
        // (it must come after beats that were the same as the bar before, and end the same way)
        let before = false; for (let j = i - 1; j >= i - 4 && j >= 4; j--) { const dj = diff(j); if (dj === 0) { before = true; break; } if (dj === 1) break; }
        if (before && clean && e - i <= 3) { const n = 4 - (e - i); for (let r = e - 3; r <= i; r++) v[mod4(kLo + r)] += 1 / n; nV++; }
        i = e;
      }
      clues.push({ name: 'bass', v: nV >= 3 ? v : [0, 0, 0, 0], n: nV });
    }
    // where the kick comes in: after an intro or a breakdown without it, the kick comes back on a 1 (a producer
    // builds the drop that way, and a DJ counts from it). A kick on a beat after at least 16 beats with none,
    // and kicks on most of the next 8 beats (not a lone hit). Not the first kick when it comes before 16 beats
    // of sound (a pickup at the very start), and not when the kick plays on one beat of the bar only: then its
    // entry is on that beat, the 3 in a one-drop, and the pattern says more.
    {
      const v = [0, 0, 0, 0], kp = clues[0].kp;
      let nE = 0;
      if (kp.filter(x => x >= 0.5).length >= 2) {
        const on = new Uint8Array(nB);
        for (let i = 0; i < nB; i++) { const ki = near(ev.Kt, T[i], TOL); on[i] = ki >= 0 && ev.kw[ki] >= 0.36 ? 1 : 0; }
        // (the sound before the first entry: each beat's level, against the track's mean)
        const d = peaks.data, lvl = i => { const fa = Math.max(0, Math.floor(T[i] * PK_RATE)), fb = Math.min(peaks.n, Math.floor(T[i + 1] * PK_RATE)); let s = 0; for (let f = fa; f < fb; f++) s += d[4 * f]; return s / Math.max(1, fb - fa); };
        let all = 0; for (let i = 0; i < nB; i++) all += lvl(i); all /= nB || 1;
        let last = -1;
        for (let i = 0; i < nB; i++) {
          if (!on[i]) continue;
          const gap = last < 0 ? i : i - last - 1;
          last = i;
          if (gap < 16 || i + 8 >= nB) continue;
          let next = 0; for (let j = i + 1; j <= i + 8; j++) next += on[j];
          if (next < 6) continue;
          if (gap === i) { let m = 0; for (let j = i - 16; j < i; j++) if (lvl(j) > 0.25 * all) m++; if (m < 12) continue; }
          v[mod4(kLo + i)] += 1; nE++;
        }
      }
      clues.push({ name: 'entry', v, n: nE });
    }
    // the vote
    const tot = [0, 0, 0, 0];
    for (const c of clues) {
      const mx = Math.max(...c.v), srt = c.v.slice().sort((x, y) => y - x);
      c.say = mx > 0 ? (srt[0] - srt[1]) / srt[0] : 0;
      c.top = mx > 0 ? c.v.indexOf(mx) : -1;
      if (mx > 0) for (let r = 0; r < 4; r++) tot[r] += c.v[r] / mx;
    }
    const order = [0, 1, 2, 3].sort((x, y) => tot[y] - tot[x]), win = order[0];
    const clear = tot[win] > 0 && tot[win] >= 1.1 * tot[order[1]];
    const backers = clues.filter(c => c.say >= 0.35 && c.top === win), against = clues.filter(c => c.say >= 0.5 && c.top !== win);
    const any = tot[win] > 0;
    // the first 1 from the first kick on
    const r1 = any ? win : mod4(first);
    const k1 = first + mod4(r1 - first);
    const by = !any ? 'first' : backers.length ? backers.map(c => c.name).join('+') : 'weak';
    return { k1, ok: clear && backers.length >= 1 && !against.length, by,
      conf: { by, vote: tot[order[1]] > 0 ? Math.round(tot[win] / tot[order[1]] * 100) / 100 : tot[win] > 0 ? 9 : 0, clues: clues.map(c => ({ name: c.name, say: Math.round(c.say * 100) / 100, top: c.top, n: c.n, kp: c.kp, sp: c.sp, v: c.v.map(x => Math.round(x * 100) / 100) })) } };
  }

  // ---------- the verdict, in words ----------
  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  // what to check (why) or what is unusual but fine (notes), one plain sentence each
  function reasonText(r) {
    switch (r.code) {
      case 'none': return 'no steady beat found';
      case 'long': return 'too long for a beat grid (over 3 hours)';
      case 'tempo2': return `the tempo could also be ${r.bpm} BPM`;
      case 'parts': return r.odd && r.odd.length ? `its parts read different tempos (the ${r.odd.map(o => `${o.part}: ${o.bpm}`).join(', the ')})` : 'its parts read different tempos';
      case 'few': return `only ${r.n || 'a few'} beats have a hit to place the grid on`;
      case 'loose': return `its hits sit loosely on the grid (${r.ms} ms; ${r.on} % on it)`;
      case 'drift': return `the tempo is not constant${r.parts && r.parts[0] && r.parts[2] ? ` (${r.parts[0]} BPM at the start, ${r.parts[2]} at the end)` : ''}${r.at != null ? `: the grid holds only to about ${mmss(r.at)}` : ''}`;
      case 'jump': return `the grid does not hold for the whole track${r.at != null ? `: it slips around ${mmss(r.at)}` : ''}`;
      case 'one': return r.by === 'first' ? 'which beat is the 1 is a guess (the first kick)' : 'which beat is the 1 is not sure (its clues are weak or disagree)';
      case 'nonwhole': return `the tempo is not a whole number (${r.bpm}): a vinyl rip or played by hand`;
      case 'halftime': return 'half-time (the kick on 1, the snare on 3), counted double';
      case 'offbeat': return 'a kick on every beat, with an offbeat hit between';
      default: return r.code;
    }
  }

  return { GRID_V, analyzeGrid, bassBand, bassNotes, findEvents, hitStart, reasonText };
});
