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
//   4b. A tempo that wanders (stage 5). Where the line doesn't hold, the beats are followed out from the seed
//      window kick by kick (across a breakdown found again from the next steady run of kicks; a slip, or the tempo
//      changing, from three kicks on a new line), and the fewest pins that hold them within 2 ms are placed: the
//      grid is those pins, the 1 and the sections are found on it. When the beats followed all sit on the straight
//      line after all, the tempo is constant: the line, unmarked.
//   4c. A band's tempo (stage 6a). Where the line doesn't hold tightly, the beat is followed through all the drums
//      (kicks, snares, rims, skanks, hats, each by how regular it is and how much of it is on the beat): the best
//      beat path through the whole track, then a smooth curve through every hit near its beats (each instrument's
//      own lag behind the kick taken off), then the fewest pins that keep the curve within 4 ms. Where the drums give
//      too little (a dub's drop, the kicks out), the grid is drawn straight across and the stretch is doubtful
//      (`doubt`). Taken only when it sits clearly better on the drums than the line or stage 5's pins.
//      Method 7 (20 Nov, after the user's Malcom X Dub): the beat path's step from beat to beat costs by the tempo the
//      windows read there when it is 1.5 % or more from the mean (a band that speeds up for good near the end); the
//      drums playing before the first sure beat or after the last are doubtful too (not drawn on at the tempo next
//      to them while called sure). And when no steady beat is found (2.): once more with the low hits counted by their
//      beater's click (a dub's busy, loud bass line, its notes taken for kicks: note `bassy`); then, for sparse drums
//      that score too low anywhere, when two thirds of the windows read the same tempo (or its double, its half) as
//      their best, that tempo, said to be faint (`faint`, to check). A track with no drums stays without a grid.
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
//   half BPM), ok, why: [{ code, ... }], notes: [{ code, ... }], conf: { ... }, drift, parts,
//   sections: [{ t, k, c }] (k: intro, kicks, main, break, drop, outro; c: how clear the change is, 0 to 1),
//   cue: { t, ok, why: [codes], alts: [t], low } (the cue by the user's rule; alts: the other places when unsure),
//   phrase: { o, conf }, pins: [[t, b]] (a tempo that wanders: the grid's pins, b counted from the 1),
//   doubt: [{ t0, t1, why }] (stage 6a: the stretches a band's grid is drawn across without the drums to follow) }
// or { v, bpm: null, ok: false, why: [{ code: 'none' }] } when no steady beat is found.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GridAnalysisCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const GRID_V = 7;                        // the method's number: another, and every automatic grid is worked out again
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
  function findEvents(hits, peaks, opts = {}) {
    const K = rowOnsets(hits.data, hits.n, 0, 24), S = rowOnsets(hits.data, hits.n, 1, 24);
    const pd = peaks.data, pn = peaks.n;
    const rise = (t, o) => {
      const f = Math.floor(t * PK_RATE);
      let be = 255, af = 0;
      for (let j = f - 2; j <= f - 1; j++) if (j >= 0 && j < pn) be = Math.min(be, pd[4 * j + o]);
      for (let j = f; j <= f + 3; j++) if (j >= 0 && j < pn) af = Math.max(af, pd[4 * j + o]);
      return be === 255 ? 0 : Math.max(0, af - be);
    };
    let refK = pct(K.s, 0.9);
    const nK = K.t.length, nS = S.t.length;
    const kw = new Float32Array(nK);
    for (let i = 0; i < nK; i++) { const r = refK > 0 ? K.s[i] / refK : 0; kw[i] = r >= 0.3 ? Math.min(1, r * r) : 0; }
    // A kick is a beater on a skin: its click comes with its low thump (the upper row rises with it). A bass note has
    // its low thump and next to no click. With `click` (asked for when the low hits make no steady beat at all: a dub's
    // busy, loud bass line, its notes as sharp as the kick and most of them off the beat): each low hit counts by its
    // click against the track's clicking ones, and the kicks are weighed against each other, not against the bass.
    let clicked = false;
    if (opts.click) {
      const click = new Float32Array(nK), hd = hits.data, hn = hits.n;
      for (let i = 0; i < nK; i++) {
        const c = Math.round(K.t[i] * HIT_RATE);
        let lo = 255, hi = 0;
        for (let j = Math.max(0, c - 25); j < c - 3; j++) if (hd[3 * j + 1] < lo) lo = hd[3 * j + 1];
        for (let j = Math.max(0, c - 3); j <= Math.min(hn - 1, c + 12); j++) if (hd[3 * j + 1] > hi) hi = hd[3 * j + 1];
        click[i] = lo === 255 ? 0 : Math.max(0, hi - lo);
      }
      const strong = []; for (let i = 0; i < nK; i++) if (kw[i] >= 0.3) strong.push(click[i]);
      const refC = strong.length >= 24 ? pct(strong, 0.9) : 0;
      const sharp = []; for (let i = 0; i < nK; i++) if (refC > 0 && click[i] >= 0.6 * refC) sharp.push(K.s[i]);
      if (refC >= 60 && sharp.length >= 16) {
        refK = pct(sharp, 0.9); clicked = true;
        for (let i = 0; i < nK; i++) {
          const r = refK > 0 ? K.s[i] / refK : 0, g = Math.min(1, click[i] / (0.6 * refC));
          kw[i] = r >= 0.3 ? Math.min(1, r * r) * g * g : 0;
        }
      }
    }
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
    return { Kt: K.t, Ks: K.s, kw, St: S.t, Ss: S.s, body, air, sw, hw, cumK: cum(kw), cumS: cum(sw), drums: Float64Array.from(drums),
      allT: Float64Array.from(all.map(e => e[0])), allW: Float32Array.from(all.map(e => e[1])), kicks: kw.filter(v => v >= 0.36).length, snares: sw.filter(v => v > 0).length, hats: hw.filter(v => v > 0).length, clicked };
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
  // ---------- 4b. a tempo that wanders: the beats followed one by one, and the pins that hold them (stage 5) ----------
  // A grid of pins, as waveview.js lays it (pinGrid): beat k at T, between two pins the beats spread evenly, before
  // the first and after the last one beat every P. pins: [[t, k]] in order.
  function beatMap(pins, P) {
    const T = pins.map(p => p[0]), K = pins.map(p => p[1]), last = T.length - 1;
    const seg = (A, x) => { let lo = 0, hi = A.length; while (lo < hi) { const m = (lo + hi) >> 1; if (A[m] <= x) lo = m + 1; else hi = m; } return lo - 1; };
    const per = i => (i < 0 || i >= last ? P : (T[i + 1] - T[i]) / (K[i + 1] - K[i]));
    return {
      beatAt: t => { const i = seg(T, t), j = Math.max(0, i); return K[j] + (t - T[j]) / per(i); },
      timeAt: k => { const i = seg(K, k), j = Math.max(0, i); return T[j] + (k - K[j]) * per(i); },
    };
  }
  // The beats followed out from one known beat (k0 at t0, about P apart), both ways, on the kicks (the strong hits
  // of the low end: a percussion's or a bass's hit is not taken for a beat), each kick's time taken on the row of
  // the hits the exact grid uses (hitStart, the same rule: under a loud bass the low end's own rise comes late).
  // Each next beat is looked for where the last few say it comes (a straight line through the last 8 found: a
  // tempo that bends is followed closely); a kick within 4 ms of that is its beat.
  // - A short passage without kicks is crossed at the tempo it had, the search widening with the gap.
  // - Across a breakdown (12 beats or more without kicks), the beats are found again from the kicks themselves: the
  //   first steady run of them (5 or more on the beats of 8 or more, on one straight line), and the beats across
  //   the gap counted at the tempo of before and after, halfway (the tempo may have changed in the gap); a run that
  //   falls between two beats so counted is not taken.
  // - Three kicks off the line, on one straight line of their own: a slip (a bad edit, a record skipping: the same
  //   tempo, the beats moved) or the tempo changing (kicks too far apart to follow it beat by beat). The line starts
  //   again from them, and the beats back to the last one found are looked for on it.
  // -> Map beat -> its kick's time
  function trackBeats(hits, row, ev, k0, t0, P, kLo, kHi, dur) {
    const found = new Map([[k0, t0]]), W = 8, ACC = 0.004, LONG = 12;
    // (strong against the low hits around it, within 8 s: under a loud bass a kick's rise is smaller, and so is
    // everything else's there)
    const KT = ev.Kt, KS = ev.Ks, keep = [];
    for (let j = 0, a = 0, b = 0; j < KT.length; j++) {
      while (KT[a] < KT[j] - 8) a++;
      while (b < KT.length && KT[b] <= KT[j] + 8) b++;
      const loc = Array.from(KS.subarray(a, b)).sort((x, y) => x - y), ref = loc[Math.floor(0.9 * (loc.length - 1))];
      if (KS[j] >= 0.6 * ref) keep.push(KT[j]);
    }
    const kicks = Float64Array.from(keep);
    // (a kick near t, within win: its time on the row; none when the row has no hit there)
    const kickNear = (t, win) => { const i = near(kicks, t, win + 0.004); if (i < 0) return null; const r = hitStart(hits, kicks[i], row, 0.012); return r != null && Math.abs(r - t) <= win ? r : null; };
    const fitOf = hist => {
      const last = hist[hist.length - 1];
      if (hist.length < 3) return { sl: P, at: k => last[1] + (k - last[0]) * P };
      let sk = 0, st = 0, skk = 0, skt = 0;
      for (const [a, b] of hist) { sk += a; st += b; skk += a * a; skt += a * b; }
      const m = hist.length, den = m * skk - sk * sk;
      if (!(den > 0)) return { sl: P, at: k => last[1] + (k - last[0]) * P };
      const sl = Math.max(P * 0.97, Math.min(P * 1.03, (m * skt - sk * st) / den));
      return { sl, at: k => st / m + sl * (k - sk / m) };
    };
    // the steady runs of kicks from time `from` on (dir: forward, or back from it), starting within 8 beats of the
    // first kick there: [{ pts: [[j, t]] (j beats from its first kick, the way it goes), P2: its tempo, tA }]
    const runsFrom = (from, dir) => {
      const out = [];
      let i = dir > 0 ? lower(kicks, from) : lower(kicks, from) - 1;
      const first = i >= 0 && i < kicks.length ? kicks[i] : null;
      for (let tries = 0; tries < 24 && i >= 0 && i < kicks.length && Math.abs(kicks[i] - first) <= 8 * P; tries++, i += dir) {
        const tA = kicks[i], pts = [];
        for (let j = i; j >= 0 && j < kicks.length && Math.abs(kicks[j] - tA) <= 32 * P; j += dir) {
          const q = Math.round(Math.abs(kicks[j] - tA) / P);
          if (Math.abs(Math.abs(kicks[j] - tA) - q * P) <= 0.03 && (!pts.length || q > pts[pts.length - 1][0])) pts.push([q, kicks[j]]);
        }
        if (pts.length < 5 || pts[pts.length - 1][0] < 8) continue;
        let use = pts, f = null;
        for (let r = 0; r < 3; r++) {
          let sk = 0, st = 0, skk = 0, skt = 0;
          for (const [a, b] of use) { sk += a; st += b; skk += a * a; skt += a * b; }
          const m = use.length, sl = (m * skt - sk * st) / (m * skk - sk * sk);
          f = { sl: Math.abs(sl), at: q => st / m + sl * (q - sk / m) };
          use = pts.filter(([q, t]) => Math.abs(t - f.at(q)) <= ACC);
          if (use.length < 5) break;
        }
        if (use.length >= 5 && Math.abs(f.sl / P - 1) <= 0.03) out.push({ pts: use, P2: f.sl, tA: f.at(0) });
      }
      return out;
    };
    for (const dir of [1, -1]) {
      let hist = [[k0, t0]], pend = [], lastK = k0;
      for (let k = k0 + dir; dir > 0 ? k <= kHi : k >= kLo; k += dir) {
        const fit = fitOf(hist), pred = fit.at(k), gap = Math.abs(k - lastK);
        if (pred < -P || pred > dur + P) continue;
        const last = hist[hist.length - 1];
        const lo = Math.min(last[1], pred) + 0.5 * P, hi = Math.max(last[1], pred) - 0.5 * P;
        const brk = gap >= LONG && lower(kicks, hi) - lower(kicks, lo) <= 1;
        if (brk) {
          // (a breakdown crossed: found again from the next steady run of kicks, if there is one near)
          const n1 = dir > 0 ? lower(kicks, pred - 0.5 * P) : lower(kicks, pred + 0.5 * P) - 1;
          if (n1 < 0 || n1 >= kicks.length || Math.abs(kicks[n1] - pred) > 0.5 * P) continue;
          // (of the runs there, the one that falls nearest a beat so counted: a run a sixteenth off, a bass's or a
          // pickup's, is not the beat)
          let run = null, x = 0, n = 0;
          for (const r of runsFrom(pred - dir * 0.5 * P, dir)) {
            const xr = Math.abs(r.tA - last[1]) / ((fit.sl + r.P2) / 2);
            if (!run || Math.abs(xr - Math.round(xr)) < Math.abs(x - n)) { run = r; x = xr; n = Math.round(xr); }
          }
          if (!run || Math.abs(x - n) > 0.3) continue;
          const kA = last[0] + dir * n;
          hist = [];
          for (const [q, t0] of run.pts) { const kk = kA + dir * q, t = hitStart(hits, t0, row, 0.012); if (t == null) continue; found.set(kk, t); hist.push([kk, t]); }
          if (!hist.length) { hist = [last]; continue; }
          hist = hist.slice(-W);
          lastK = hist[hist.length - 1][0]; k = lastK; pend = [];
          continue;
        }
        const win = Math.min(0.03, 0.006 + 0.0012 * gap + (hist.length < 4 ? 0.014 : 0));
        const t = kickNear(pred, win);
        if (t != null && Math.abs(t - pred) <= (hist.length < 4 ? win : ACC)) {
          hist.push([k, t]); if (hist.length > W) hist.shift();
          found.set(k, t); pend = []; lastK = k;
          continue;
        }
        // (off the line: a slip's first kicks, perhaps, looked for further out; not across a breakdown, where the
        // beats are found again as above)
        const w2 = Math.min(0.06, 0.15 * P), t2 = kickNear(pred, w2);
        if (t2 == null) continue;
        pend.push([k, t2, t2 - pred]);
        if (pend.length < 3) continue;
        const nf = fitOf(pend.map(x => [x[0], x[1]]));
        if (pend.some(x => Math.abs(x[1] - nf.at(x[0])) > 0.0015) || Math.abs(nf.sl / P - 1) > 0.02) { pend.shift(); continue; }
        const es = pend.map(x => x[2]), same = Math.max(...es) - Math.min(...es) < 0.003;
        const at = same ? (kk => pend[0][1] + (kk - pend[0][0]) * fit.sl) : nf.at;
        // (only when the kicks after them go on on the new line, and not on the old one: a pattern with some kicks
        // played late, a shuffle, is not a slip; at the track's end, with no kicks after, they are taken)
        let nNew = 0, nOld = 0;
        for (let j = 1; j <= 12; j++) { const kk = k + dir * j; if (kickNear(at(kk), ACC) != null) nNew++; if (kickNear(fit.at(kk), ACC) != null) nOld++; }
        if (nOld * 3 > nNew || (nNew < 2 && nOld > 0)) { pend.shift(); continue; }   // (none either way: the track's end)
        for (const x of pend) found.set(x[0], x[1]);
        for (let kk = pend[0][0] - dir; dir > 0 ? kk > lastK : kk < lastK; kk -= dir) {
          const p2 = at(kk), t3 = kickNear(p2, ACC);
          if (t3 != null) found.set(kk, t3);
        }
        hist = pend.map(x => [x[0], x[1]]);
        lastK = k; pend = [];
      }
    }
    return found;
  }
  // The fewest pins that hold the beats followed (obs: [[k, t]] in order) within `tol`: stretches grown one beat at a
  // time while one straight line holds all their hits; where two stretches meet, a pin on the bar line where their
  // lines cross (the tempo changing), or two pins a beat apart where the lines are parallel and apart (a slip).
  // The first pin on the first bar line in the track, the last on the last: the tempo at each end goes on to the end.
  // -> { pins: [[t, k]], segs }
  function pinsOf(obs, tol, dur) {
    const lineOf = (s, e) => {
      let sk = 0, st = 0, skk = 0, skt = 0; const m = e - s + 1;
      for (let i = s; i <= e; i++) { const [k, t] = obs[i]; sk += k; st += t; skk += k * k; skt += k * t; }
      const den = m * skk - sk * sk, sl = den > 0 ? (m * skt - sk * st) / den : 0;
      return { sl, ic: (st - sl * sk) / m, at: k => (st - sl * sk) / m + sl * k };
    };
    const holds = (s, e, f) => { for (let i = s; i <= e; i++) if (Math.abs(obs[i][1] - f.at(obs[i][0])) > tol) return false; return true; };
    const segs = [];
    for (let s = 0; s < obs.length;) {
      let e = Math.min(obs.length - 1, s + 1), f = lineOf(s, e);
      for (let j = e + 1; j < obs.length; j++) { const g = lineOf(s, j); if (!holds(s, j, g)) break; e = j; f = g; }
      segs.push({ s, e, f, k0: obs[s][0], k1: obs[e][0] });
      s = e + 1;
    }
    const pins = [];
    const put = (t, k) => { if (!pins.length || (k > pins[pins.length - 1][1] && t > pins[pins.length - 1][0] + 1e-4)) pins.push([t, k]); };
    const A = segs[0], Z = segs[segs.length - 1];
    // (the first bar line in the track, on the first stretch's line)
    const kStart = 4 * Math.ceil((-A.f.ic / A.f.sl) / 4 - 1e-9);
    put(A.f.at(kStart), kStart);
    for (let i = 0; i + 1 < segs.length; i++) {
      const a = segs[i], b = segs[i + 1];
      // where the two lines cross, kept between the last beat of one and the first of the next (a bar either side)
      const kx = Math.abs(a.f.sl - b.f.sl) > 1e-9 ? (b.f.ic - a.f.ic) / (a.f.sl - b.f.sl) : (a.k1 + b.k0) / 2;
      const kc = Math.max(a.k1 - 4, Math.min(b.k0 + 4, kx));
      const kb = 4 * Math.round(kc / 4);
      if (Math.abs(a.f.at(kb) - b.f.at(kb)) <= tol) put((a.f.at(kb) + b.f.at(kb)) / 2, kb);
      else { put(a.f.at(a.k1), a.k1); put(b.f.at(b.k0), b.k0); }
    }
    const kEnd = 4 * Math.floor(((dur - Z.f.ic) / Z.f.sl) / 4 + 1e-9);
    put(Z.f.at(kEnd), kEnd);
    return { pins, segs };
  }
  // Follow the beats from one known beat and pin them. -> { pins, map, obs, P } or
  // null when they can't be followed over most of the drums (then the track stays marked as drifting)
  function bendOf(hits, row, ev, k0, t0, P, kLo, kHi, dur) {
    const f = trackBeats(hits, row, ev, k0, t0, P, kLo, kHi, dur);
    const obs = [...f.entries()].sort((x, y) => x[0] - y[0]);
    if (obs.length < 32) return null;
    // (followed over most of the track where the drums play: the first and last drums within a few bars of the hits)
    const d0 = ev.drums[0], d1 = ev.drums[ev.drums.length - 1], span = obs[obs.length - 1][1] - obs[0][1];
    if (span < 0.6 * (d1 - d0)) return null;
    const { pins, segs } = pinsOf(obs, 0.002, dur);
    if (pins.length < 2) return null;
    const Pm = (pins[pins.length - 1][0] - pins[0][0]) / (pins[pins.length - 1][1] - pins[0][1]);
    const map = beatMap(pins, Pm);
    let on = 0, ss = 0;
    for (const [k, t] of obs) { const e = t - map.timeAt(k); if (Math.abs(e) <= 0.003) on++; ss += e * e; }
    if (on < 0.9 * obs.length) return null;
    return { pins, map, obs, P: Pm, row, on: on / obs.length, rms: Math.sqrt(ss / obs.length) * 1000, segs: segs.length };
  }

  // ---------- 4c. a band's tempo (stage 6a): every drum, the best beat path, a smooth curve, the fewest pins ----------
  // Music played by a band breathes: its tempo moves a little all the time, and its drummer's hits are each a few ms
  // off the beat. Stage 5 follows kicks one by one and looks for slips; a one-drop has a kick a bar, and a band's beat
  // is in all of its drums. So, from one known beat (the line's, near its seed window):
  //   1. the families: kicks (on the grid's row, as the line), softer low hits (a bass's notes), bright snares (a
  //      snare, a rim, a clap), dark ones (a skank, a tom), hats; each weighed by
  //      how regular it is in the track (how many of its hits have another one beat or two beats later), so a busy
  //      percussion counts for little;
  //   2. the best beat path through the whole track (dynamic programming, in the manner of Ellis 2007): every frame's
  //      best score is its drums plus the best of the beats a period before it, less a cost for a beat interval
  //      away from the period. A breakdown has no drums: the path crosses it at the tempo of the two sides;
  //   3. every hit near a beat of the path is that beat's, and the beat's time is a smooth curve through them (a local
  //      straight line over 8 beats either side, weighted, and twice again with the hits far off it counting less):
  //      a drummer's few ms either way average out; a snare or a skank played behind the beat on purpose is moved
  //      by its own family's lag (the kick is the beat);
  //   4. where the hits are too few (the drums out: a dub's drop), the curve is drawn straight across from the two
  //      sides and the stretch is doubtful;
  //   5. the fewest pins (on every 4th beat) whose straight stretches keep the curve within 4 ms.
  // -> { pins, map, obs, P, row, on, rms, segs, live: true, doubt: [[k0, k1]], ev: e (beat -> its hits' time), sure }
  //    or null when the path can't be found from the known beat
  const LIVE_R = 250, LIVE_ALPHA = 400, LIVE_H = 8, LIVE_TOL = 0.004, LIVE_PRIOR = 0.25;
  function liveOf(hits, ev, row, kS, tS, P, dur, w0, w1, prior, local) {
    const R = LIVE_R, N = Math.ceil(dur * R) + 1;
    // 1. the families
    // (the snares in two: the bright ones (a snare's noise, a rim, a clap) and the dark ones (a chord's skank, a tom):
    // two players, each with a lag of their own)
    // (and the low hits in two: the kicks, the beat itself, and the softer ones: a bass's notes, a kick played softly,
    // late or early in their own way)
    const NF = 5, fam = [[], [], [], [], []];
    for (let i = 0; i < ev.Kt.length; i++) if (ev.kw[i] >= 0.3) { const t = hitStart(hits, ev.Kt[i], row, 0.012); fam[ev.kw[i] >= 0.5 ? 0 : 4].push([t != null ? t : ev.Kt[i], ev.kw[i]]); }
    // (a hit of the upper row with a kick is timed by the kick's own click: the kick's, not the snare's or the skank's)
    const KT0 = Float64Array.from(fam[0].map(x => x[0]).sort((x, y) => x - y));
    for (let i = 0; i < ev.St.length; i++) {
      if (near(KT0, ev.St[i], 0.012) >= 0) continue;
      if (ev.sw[i] >= 0.3) fam[ev.air[i] >= 0.6 * ev.body[i] ? 1 : 2].push([ev.St[i], ev.sw[i]]); else if (ev.hw[i] > 0.02) fam[3].push([ev.St[i], ev.hw[i]]);
    }
    // (and how much of it is on the beats where they are known, the seed window: hats on the offbeats keep time
    // too, but they are not the beat, and a path through them would be half a beat off)
    const fw = fam.map(F => {
      if (F.length < 16) return 0;
      const T = Float64Array.from(F.map(x => x[0])), ref = pct(F.map(x => x[1]), 0.9) || 1;
      let on = 0, all = 0, bOn = 0, bAll = 0;
      for (const [t, w] of F) {
        all += w; if ([1, 2, 4].some(m => near(T, t + m * P, 0.012 + 0.006 * m) >= 0)) on += w;
        if (t >= w0 && t <= w1) { const u = (t - tS) / P; bAll += w; if (Math.abs(u - Math.round(u)) * P <= Math.min(0.025, 0.12 * P)) bOn += w; }
      }
      for (const x of F) x[1] = Math.min(1, x[1] / ref);
      return (all > 0 ? on / all : 0) * (bAll > 0 ? bOn / bAll : 0);
    });
    // 2. the beat path; twice: the second time each family weighed by how much of it is on the first path's beats
    // over the whole track (the seed window alone may have no hats, or a fill)
    // (the step from one beat to the next costs by how far it is from the tempo there: where the windows read a tempo
    // well apart from the track's mean (1.5 % or more: a band that speeds up for good near the end, a splice, a tape),
    // their own reading, from one window's middle to the next, so the new tempo isn't paid for at every beat; else
    // the mean)
    const Pf = P * R, dLo = Math.floor(Pf * 0.92), dHi = Math.ceil(Pf * 1.08);
    const PL = new Float32Array(N).fill(Pf);
    if (local && local.length >= 2) {
      const L = local.slice().sort((x, y) => x[0] - y[0]);
      for (let i = 0; i < N; i++) {
        const t = i / R; let q = 0; while (q + 1 < L.length && L[q + 1][0] <= t) q++;
        const v = t <= L[0][0] ? L[0][1] : q + 1 >= L.length ? L[L.length - 1][1] : L[q][1] + (L[q + 1][1] - L[q][1]) * (t - L[q][0]) / (L[q + 1][0] - L[q][0]);
        // (a band breathes by a percent or so, which the hits show well enough: only a change beyond that is taken)
        if (Math.abs(Math.log(v / P)) >= 0.015) PL[i] = Math.max(dLo + 1, Math.min(dHi - 1, v * R));
      }
    }
    const LG = new Float32Array(dHi + 1); for (let d = Math.max(1, dLo); d <= dHi; d++) LG[d] = Math.log(d);
    const O = new Float32Array(N), C = new Float64Array(N), B = new Int32Array(N), sg = 0.010 * R, rad = Math.ceil(3 * sg);
    const pathOf = fwu => {
      O.fill(0);
      for (let f = 0; f < NF; f++) if (fwu[f] > 0) for (const [t, w] of fam[f]) {
        const c = t * R, i0 = Math.max(0, Math.floor(c - rad)), i1 = Math.min(N - 1, Math.ceil(c + rad));
        for (let i = i0; i <= i1; i++) O[i] += fwu[f] * w * Math.exp(-0.5 * ((i - c) / sg) ** 2);
      }
      const pk = []; for (let i = 1; i + 1 < N; i++) if (O[i] > 0.05 && O[i] >= O[i - 1] && O[i] > O[i + 1]) pk.push(O[i]);
      const ref = pct(pk, 0.8); if (!(ref > 0)) return null;
      for (let i = 0; i < N; i++) O[i] /= ref;
      // (and, softly, the beats each window of the tempo reading laid: where two paths explain the drums about as well,
      // a bass line rolling on the offbeats as loud as the kicks, the one on the windows' beats. The path only says
      // which beat each hit is; the curve is the hits' own)
      for (const [t0, t1, a0, Pw] of prior) for (let k = Math.ceil((t0 - a0) / Pw); a0 + k * Pw <= t1; k++) {
        const c = (a0 + k * Pw) * R, r2 = Math.ceil(3 * 0.02 * R);
        for (let i = Math.max(0, Math.floor(c - r2)); i <= Math.min(N - 1, Math.ceil(c + r2)); i++) O[i] += LIVE_PRIOR * Math.exp(-0.5 * ((i - c) / (0.02 * R)) ** 2);
      }
      for (let i = 0; i < N; i++) {
        let best = 0, bj = -1;
        const lp = Math.log(PL[i]);
        for (let d = dLo; d <= dHi && i - d >= 0; d++) { const v = C[i - d] - LIVE_ALPHA * (LG[d] - lp) ** 2; if (v > best) { best = v; bj = i - d; } }
        C[i] = O[i] + best; B[i] = bj;
      }
      let end = N - 1;
      for (let i = Math.max(0, N - dHi); i < N; i++) if (C[i] > C[end]) end = i;
      const pa = [];
      for (let i = end; i >= 0; i = B[i]) pa.push(i / R);
      return pa.reverse();
    };
    let path = pathOf(fw);
    if (!path || path.length < 32) return null;
    {
      const BT = Float64Array.from(path), fw2 = fam.map((F, f) => {
        if (!fw[f] && F.length < 16) return 0;
        let on = 0, all = 0;
        for (const [t, w] of F) { if (t < path[0] || t > path[path.length - 1]) continue; all += w; if (near(BT, t, Math.min(0.025, 0.12 * P)) >= 0) on += w; }
        const T = Float64Array.from(F.map(x => x[0]));
        let rg = 0, ra = 0; for (const [t, w] of F) { ra += w; if ([1, 2, 4].some(m => near(T, t + m * P, 0.012 + 0.006 * m) >= 0)) rg += w; }
        return (ra > 0 ? rg / ra : 0) * (all > 0 ? on / all : 0);
      });
      if (fw2.some((x, f) => Math.abs(x - fw[f]) > 0.05)) { for (let f = 0; f < NF; f++) fw[f] = fw2[f]; const p2 = pathOf(fw); if (p2 && p2.length >= 32) path = p2; }
    }
    // (numbered from the known beat: the path's beat nearest it is kS)
    let j0 = 0;
    for (let j = 1; j < path.length; j++) if (Math.abs(path[j] - tS) < Math.abs(path[j0] - tS)) j0 = j;
    if (Math.abs(path[j0] - tS) > 0.25 * P) return null;
    const kA = kS - j0, nK = path.length;
    // 3. the hits of each beat
    // (first by the path, within 40 ms; then again by the curve, closer: a hat a 16th before the beat is not the beat's)
    let obs = [], byJ = null;
    const assign = (BT, tol) => {
      const prev = new Map(obs.map(o => [o.t * 10 + o.f, o.r]));
      obs = [];
      for (let f = 0; f < NF; f++) if (fw[f] > 0) for (const [t, w] of fam[f]) {
        const j = near(BT, t, tol);
        if (j >= 0) obs.push({ j, t, w: w * fw[f], f, r: prev.has(t * 10 + f) ? prev.get(t * 10 + f) : 1 });
      }
      byJ = Array.from({ length: nK }, () => []);
      for (const o of obs) byJ[o.j].push(o);
    };
    assign(Float64Array.from(path), Math.min(0.04, 0.15 * P));
    if (obs.length < 32) return null;
    const off = new Array(NF).fill(0);
    // the curve, over H beats either side; loo: each beat from its neighbours alone (to judge H by)
    const smooth = (H, loo) => {
      const S = new Float64Array(nK).fill(NaN), W = new Float64Array(nK);
      for (let j = 0; j < nK; j++) {
        let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, near2 = 0;
        for (let q = Math.max(0, j - H); q <= Math.min(nK - 1, j + H); q++) {
          if (loo && q === j) continue;
          const u = Math.abs(q - j) / (H + 1), kw = (1 - u * u * u) ** 3;
          for (const o of byJ[q]) {
            const w = o.w * o.r * kw, y = o.t - off[o.f] - (path[0] + q * P), x = q - j;
            sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
            if (Math.abs(q - j) <= 2) near2 += o.w * o.r;
          }
        }
        W[j] = near2;
        if (!(sw > 0)) continue;
        const den = sw * sxx - sx * sx, b = den > 1e-9 ? (sw * sxy - sx * sy) / den : 0;
        S[j] = path[0] + j * P + (sy - b * sx) / sw;
      }
      return { S, W };
    };
    const wmed = A => { if (!A.length) return 0; A.sort((x, y) => x[0] - y[0]); const tot = A.reduce((s, x) => s + x[1], 0); let c = 0; for (const [v, w] of A) { c += w; if (c >= tot / 2) return v; } return A[A.length - 1][0]; };
    // (how far apart: the width that best tells each beat's hits from its neighbours', with the hits far off counting less)
    const cvOf = H => { const L = smooth(H, true).S; let e = 0, n = 0; for (const o of obs) if (isFinite(L[o.j])) { const d = o.t - off[o.f] - L[o.j], w = o.w * o.r; e += w * Math.min(d * d, 0.0004); n += w; } return n ? e / n : 1; };
    let H = LIVE_H, sm = smooth(H), refF = 0;
    const nres = new Array(NF).fill(0);
    for (let it = 0; it < 4; it++) {
      // (each family's own lag behind the kicks (the beat, when there are enough of them), then the hits far off the
      // curve counting less, then the width)
      const res = fam.map(() => []);
      for (const o of obs) if (isFinite(sm.S[o.j])) res[o.f].push([o.t - off[o.f] - sm.S[o.j], o.w * o.r]);
      const tot = res.map(A => A.reduce((s, x) => s + x[1], 0));
      refF = res[0].length >= 32 ? 0 : tot.indexOf(Math.max(...tot));
      for (let f = 0; f < NF; f++) nres[f] = res[f].length;
      const d = res.map(A => wmed(A.slice()));
      for (let f = 0; f < NF; f++) off[f] += d[f] - d[refF];
      const all = [];
      for (const o of obs) if (isFinite(sm.S[o.j])) all.push([Math.abs(o.t - off[o.f] - sm.S[o.j]), o.w]);
      const sc = Math.max(0.002, 1.4826 * wmed(all));
      for (const o of obs) { const e = isFinite(sm.S[o.j]) ? (o.t - off[o.f] - sm.S[o.j]) / (4.685 * sc) : 0; o.r = Math.abs(e) < 1 ? (1 - e * e) ** 2 : 0; }
      if (it === 1) { let bh = H, be = Infinity; for (const h of [4, 6, 8, 12, 16, 24]) { const e = cvOf(h); if (e < be) { be = e; bh = h; } } H = bh; }
      sm = smooth(H);
      if (it === 0 || it === 2) { const BT = Float64Array.from(sm.S, (x, j) => (isFinite(x) ? x : path[j] + off[0])); for (let j = 1; j < nK; j++) if (BT[j] <= BT[j - 1]) BT[j] = BT[j - 1] + 1e-6; assign(BT, Math.min(0.022, 0.08 * P)); sm = smooth(H); }
    }
    // 4. sure where the hits are enough, doubtful stretches (a bar or more) where they aren't: drawn straight across
    // (enough: hits on 3 of the 5 beats around, weighing a quarter of what the beats usually have around them, or on 4
    // of the 5 (hats alone): a few loose hits in a breakdown, a riser's notes, are not a beat to follow)
    const sure = new Uint8Array(nK), wRef = pct(Array.from(sm.W).filter(x => x > 0), 0.5);
    const has = j => byJ[j].some(o => o.r > 0);
    // (and most of what the drums play there on the beats: in a breakdown, a pad's own movements, a reverb's tails fall
    // anywhere, as many between the beats as on them)
    // (per family: a fill's snares run through the 16ths while its kicks stay on the beat; a breakdown's loose hits are
    // off the beat in every family. The best family with 3 hits or more says)
    const FT = fam.map(F => Float64Array.from(F.map(x => x[0]).sort((x, y) => x - y))), tolOn = Math.min(0.025, 0.1 * P);
    const onShare = j => {
      const q0 = Math.max(0, j - 4), q1 = Math.min(nK - 1, j + 4), lo = path[q0] - 0.5 * P, hi = path[q1] + 0.5 * P;
      let best = 0;
      for (let f = 0; f < NF; f++) {
        if (!(fw[f] > 0)) continue;
        const T = FT[f], tot = lower(T, hi) - lower(T, lo);
        if (tot < 3) continue;
        let on = 0;
        for (let q = q0; q <= q1; q++) if (isFinite(sm.S[q])) on += lower(T, sm.S[q] + tolOn) - lower(T, sm.S[q] - tolOn);
        best = Math.max(best, on / tot);
      }
      return best;
    };
    // (and the beat's own family, the kicks, within 3 beats: where they are out, the others give the band's time but not
    // quite its place, each instrument late or early in its own way, by up to 10-15 ms)
    const refN = new Int32Array(nK + 1); for (let j = 0; j < nK; j++) refN[j + 1] = refN[j] + (byJ[j].some(o => o.f === refF && o.r > 0) ? 1 : 0);
    const refNear = j => refN[Math.min(nK, j + 4)] - refN[Math.max(0, j - 3)] > 0;
    for (let j = 0; j < nK; j++) { let c = 0; for (let q = Math.max(0, j - 2); q <= Math.min(nK - 1, j + 2); q++) if (has(q)) c++; if (isFinite(sm.S[j]) && c >= 3 && (sm.W[j] >= 0.25 * wRef || c >= 4) && onShare(j) >= 0.3 && refNear(j)) sure[j] = 1; }
    const doubt = [];
    for (let j = 0; j < nK;) { if (sure[j]) { j++; continue; } let e = j; while (e + 1 < nK && !sure[e + 1]) e++; if (e - j + 1 >= 4) doubt.push([j, e]); else for (let q = j; q <= e; q++) if (isFinite(sm.S[q])) sure[q] = 1; j = e + 1; }
    // (a short stretch that looks sure in the middle of a doubtful one, a bass line on the offbeats in a dub's drop, is
    // only trusted when it falls on the beats of the music nearest it, counted on at its tempo)
    { const runs = []; for (let j = 0; j < nK;) { if (!sure[j]) { j++; continue; } let e = j; while (e + 1 < nK && sure[e + 1]) e++; runs.push([j, e]); j = e + 1; }
      const loc = (a, b) => { let sk = 0, st = 0, skk = 0, skt = 0, m = 0; for (let q = a; q <= b; q++) if (sure[q]) { sk += q; st += sm.S[q]; skk += q * q; skt += q * sm.S[q]; m++; } const den = m * skk - sk * sk; return m >= 4 && den > 0 ? { sl: (m * skt - sk * st) / den, at: q => (st - (m * skt - sk * st) / den * sk) / m + (m * skt - sk * st) / den * q } : null; };
      // (against the nearest long stretch, 32 beats or more, either side)
      const solid = runs.filter(([a, b]) => b - a + 1 >= 32);
      for (const [a, b] of runs) {
        if (b - a + 1 >= 32 || !solid.length) continue;
        const pa = solid.filter(r => r[1] < a).pop(), pb = solid.find(r => r[0] > b);
        const L1 = pa ? loc(Math.max(pa[0], pa[1] - 11), pa[1]) : null, L2 = pb ? loc(pb[0], Math.min(pb[1], pb[0] + 11)) : null;
        const tA = sm.S[a], tB = sm.S[b], gapL = pa ? tA - sm.S[pa[1]] : Infinity, gapR = pb ? sm.S[pb[0]] - tB : Infinity;
        const L = gapL <= gapR ? L1 : L2, t = gapL <= gapR ? tA : tB;
        if (!L) continue;
        const u = (t - L.at(0)) / L.sl;
        if (Math.abs(u - Math.round(u)) > 0.25) for (let q = a; q <= b; q++) sure[q] = 0;
      }
      doubt.length = 0;
      for (let j = 0; j < nK;) { if (sure[j]) { j++; continue; } let e = j; while (e + 1 < nK && !sure[e + 1]) e++; if (e - j + 1 >= 4) doubt.push([j, e]); j = e + 1; }
    }
    const S = sm.S, js = []; for (let j = 0; j < nK; j++) if (sure[j]) js.push(j);
    if (js.length < 32) return null;
    // (across a doubtful stretch, how many beats: the path counts them at the track's mean tempo; the band's tempo on
    // either side says better. Where the two disagree, the beats after it are numbered as the two sides say)
    const kOf = new Int32Array(nK);
    { const slope = (list) => { if (list.length < 4) return null; let sk = 0, st = 0, skk = 0, skt = 0; for (const j of list) { sk += j; st += S[j]; skk += j * j; skt += j * S[j]; } const m = list.length, den = m * skk - sk * sk; return den > 0 ? (m * skt - sk * st) / den : null; };
      let shift = 0, di = 0;
      for (let j = 0; j < nK; j++) {
        while (di < doubt.length && doubt[di][1] + 1 < j) di++;
        if (di < doubt.length && doubt[di][1] + 1 === j && doubt[di][0] > 0 && sure[doubt[di][0] - 1]) {
          const ja = doubt[di][0] - 1, jb = j, before = [], after = [];
          for (let q = ja; q >= 0 && before.length < 12 && ja - q < 24; q--) if (sure[q]) before.push(q);
          for (let q = jb; q < nK && after.length < 12 && q - jb < 24; q++) if (sure[q]) after.push(q);
          const p1 = slope(before), p2 = slope(after);
          if (p1 && p2 && sure[jb]) { const x = (S[jb] - S[ja]) / ((p1 + p2) / 2), n = Math.round(x); if (Math.abs(x - n) < 0.3 && n > 0) shift += n - (jb - ja); }
        }
        kOf[j] = kA + j + shift;
      }
    }
    const kLo2 = kOf[0], kHi2 = kOf[nK - 1], nC = kHi2 - kLo2 + 1, have = new Uint8Array(nC), cv = new Float64Array(nC);
    for (const j of js) { have[kOf[j] - kLo2] = 1; cv[kOf[j] - kLo2] = S[j]; }
    // (outside the sure beats, straight on: between two, across; before the first and after the last, at their tempo)
    const idx = []; for (let i = 0; i < nC; i++) if (have[i]) idx.push(i);
    const slopeAt = (from, dir) => { const pts = []; for (let i = from; pts.length < 8 && i >= 0 && i < idx.length; i += dir) pts.push(idx[i]); const a0 = pts[0], a1 = pts[pts.length - 1]; return a1 !== a0 ? (cv[a1] - cv[a0]) / (a1 - a0) : P; };
    const first = idx[0], last = idx[idx.length - 1], s0 = slopeAt(0, 1), s1 = slopeAt(idx.length - 1, -1);
    for (let i = 0, p = -1; i < nC; i++) {
      if (have[i]) { p = i; continue; }
      if (i < first) { cv[i] = cv[first] - (first - i) * s0; continue; }
      if (i > last) { cv[i] = cv[last] + (i - last) * s1; continue; }
      let n = i + 1; while (!have[n]) n++;
      cv[i] = cv[p] + (cv[n] - cv[p]) * (i - p) / (n - p);
    }
    // (the doubtful stretches, on the beats so numbered: every run of two bars or more without a sure beat)
    // (not before the first sure beat or after the last: the track's start and end, nothing playing to follow)
    const doubtK = [];
    // (two bars or more: a bar's fill or a missed kick is drawn across as well, and is not worth a look)
    for (let i = first; i <= last;) { if (have[i]) { i++; continue; } let e = i; while (e + 1 < nC && !have[e + 1]) e++; if (e - i + 1 >= 8) doubtK.push([kLo2 + i, kLo2 + e]); i = e + 1; }
    // (but where the drums do play before the first sure beat or after the last, two bars or more of them, the grid
    // there only goes on at the tempo next to it: doubtful too. An outro whose kicks are softer than the rest, the
    // band slowing for the end, is not a place to trust a straight line)
    { const played = j => byJ[j].some(o => o.r > 0) || byJ[j].length >= 2;
      let jF = 0; while (jF < nK && !sure[jF]) jF++;
      let jL = nK - 1; while (jL >= 0 && !sure[jL]) jL--;
      let a = -1; for (let j = 0; j < jF; j++) if (played(j)) { a = j; break; }
      if (a >= 0) { let c = 0; for (let j = a; j < jF; j++) if (played(j)) c++; if (jF - a >= 8 && c >= 4) doubtK.unshift([kOf[0], kOf[jF] - 1]); }
      let b = -1; for (let j = nK - 1; j > jL; j--) if (played(j)) { b = j; break; }
      if (b >= 0) { let c = 0; for (let j = jL + 1; j <= b; j++) if (played(j)) c++; if (b - jL >= 8 && c >= 4) doubtK.push([kOf[jL] + 1, kOf[nK - 1]]); }
    }
    // the evidence itself, beat by beat: its kick (the beat's own family; the weighted middle when there are more), to
    // judge grids by. The others' lags are estimates; the kick is where the beat is
    const evid = new Map();
    for (const j of js) {
      if (!byJ[j].length) continue;
      const A = byJ[j].filter(o => o.r > 0 && o.f === refF).map(o => [o.t - off[o.f], o.w * o.r]).sort((x, y) => x[0] - y[0]);
      const tot = A.reduce((s, x) => s + x[1], 0); if (!(tot > 0)) continue;
      let c = 0; for (const [v, w] of A) { c += w; if (c >= tot / 2) { evid.set(kOf[j], v); break; } }
    }
    // 5. the pins: from the first bar line in the track to the last, each stretch as long as its straight line keeps
    // every beat within 4 ms of the curve
    const Sk = k => { const i = k - kLo2; if (i >= 0 && i < nC) return cv[i]; return i < 0 ? cv[0] + i * s0 : cv[nC - 1] + (i - nC + 1) * s1; };
    // (the first pin on the first beat in the track, the last on the last: before and after them a grid of pins goes on
    // at its mean tempo, which a band's tempo there may not be; the ones between on bar lines)
    let kb0 = kLo2; while (Sk(kb0) < 0) kb0++; while (Sk(kb0 - 1) >= 0) kb0--;
    let kb1 = kHi2; while (Sk(kb1) > dur) kb1--; while (Sk(kb1 + 1) <= dur) kb1++;
    const knots = [kb0];
    for (let ka = kb0; ka < kb1;) {
      let ok = Math.min(kb1, 4 * Math.floor(ka / 4) + 4);
      for (let kb = ok; kb <= kb1; kb = kb + 4 > kb1 && kb < kb1 ? kb1 : kb + 4) {
        const ta = Sk(ka), sl = (Sk(kb) - ta) / (kb - ka);
        let good = true;
        for (let k = ka + 1; k < kb; k++) if (Math.abs(ta + sl * (k - ka) - Sk(k)) > LIVE_TOL) { good = false; break; }
        if (!good) break;
        ok = kb;
      }
      knots.push(Math.min(ok, kb1)); ka = Math.min(ok, kb1);
    }
    const pins = knots.map(k => [Sk(k), k]);
    const Pm = (pins[pins.length - 1][0] - pins[0][0]) / (pins[pins.length - 1][1] - pins[0][1]);
    const map = beatMap(pins, Pm);
    let ss = 0, n = 0;
    for (const o of obs) if (o.r > 0 && sure[o.j]) { const e = o.t - off[o.f] - map.timeAt(kOf[o.j]); ss += e * e * o.w; n += o.w; }
    return { pins, map, obs: js.map(j => [kOf[j], S[j]]), P: Pm, row, on: js.length / nK, rms: n ? Math.sqrt(ss / n) * 1000 : 0, segs: pins.length - 1, live: true,
      doubt: doubtK, evid, off: off.map(x => Math.round(x * 1e4) / 10), fw: fw.map(x => Math.round(x * 100) / 100), sure: js.length, H, curve: Sk, nres };
  }
  // How well a grid (s -> its beat number) sits on the evidence: over every 16 beats the middle of the distances from the
  // beats' kicks to the grid's nearest line; the worst of those (ms). A grid that loses the beat somewhere shows there.
  function evidErr(evid, beatAt) {
    const ks = [...evid.keys()].sort((a, b) => a - b), win = [];
    const d = t => { const u = beatAt(t), k = Math.round(u), u1 = beatAt(t + 0.001); return Math.abs(u - k) / Math.max(1e-6, (u1 - u) / 0.001); };
    if (!ks.length) return 0;
    // (16 beats in a row, 4 of them with their kick at least: a one-drop has one a bar)
    for (let k0 = ks[0], i = 0; k0 <= ks[ks.length - 1]; k0 += 8) {
      while (i < ks.length && ks[i] < k0) i++;
      const e = []; for (let q = i; q < ks.length && ks[q] < k0 + 16; q++) e.push(d(evid.get(ks[q])));
      if (e.length < 4) continue;
      e.sort((a, b) => a - b); win.push(e[e.length >> 1]);
    }
    win.sort((a, b) => a - b);
    return win.length ? win[win.length - 1] * 1000 : 0;
  }

  function analyzeGrid(peaks, hits, opts = {}) {
    if (!hits || !hits.data || hits.rate !== HIT_RATE || !peaks || !peaks.data || hits.n < 8 * HIT_RATE) return null;
    const dur = hits.n / HIT_RATE, none = code => ({ v: GRID_V, bpm: null, ok: false, why: [{ code }], notes: [], sections: [] });
    // -- 2. the windows' readings, added up by tempo
    const readAll = (ev, lenient) => {
      if (ev.drums.length < 24) return { none: 'drums' };
      const wins = [];
      for (let t0 = 0; t0 < Math.max(1, dur - WIN / 2); t0 += HOP) { const r = readWindow(ev, t0, Math.min(dur, t0 + WIN)); if (r) wins.push(r); }
      if (!wins.length) return { none: 'windows' };
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
      if (clusters[0].agg > 0.12) return { wins, clusters };
      // (lenient: sparse drums, a dub's, explain too little of what plays to score well anywhere; but where window after
      // window, through most of the track, reads the same tempo (or its double, its half) as its best, that is a steady
      // beat all the same: its cluster, said to be faint. A track with no drums reads too few windows for it)
      if (lenient && wins.length >= 10) {
        const bests = wins.map(w => w.reduce((x, y) => (y.score > x.score ? y : x)));
        let fam = null;
        for (const b of bests) { const n = bests.filter(c => [1, 2, 0.5].some(f => Math.abs(Math.log(c.bpm / (b.bpm * f))) < 0.015)).length; if (!fam || n > fam.n) fam = { bpm: b.bpm, n }; }
        if (fam.n >= 0.65 * bests.length) {
          const inFam = clusters.filter(cl => [1, 2, 0.5].some(f => Math.abs(Math.log(cl.bpm / (fam.bpm * f))) < 0.015));
          if (inFam.length && inFam[0].agg >= 0.06) { const i = clusters.indexOf(inFam[0]); clusters.splice(i, 1); clusters.unshift(inFam[0]); return { wins, clusters, faint: true }; }
        }
      }
      return { none: 'score ' + clusters[0].agg };
    };
    let ev = findEvents(hits, peaks), rd = readAll(ev), bassy = false;
    // (no steady beat: once more with the low hits counted by their beater's click, a busy bass's notes not taken for
    // kicks. A track with no drums at all stays without)
    if (rd.none) {
      const ev2 = findEvents(hits, peaks, { click: true });
      if (ev2.clicked) { const rd2 = readAll(ev2, true); if (!rd2.none) { ev = ev2; rd = rd2; bassy = true; } }
      if (rd.none) { const rd3 = readAll(ev, true); if (!rd3.none) rd = rd3; }
    }
    if (rd.none) return none(opts.debug ? 'none:' + rd.none : 'none');
    const { wins, clusters } = rd;
    let pick = clusters[0];
    const notes = [], why = [];
    if (bassy) notes.push({ code: 'bassy' });
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
    // (no straight line holds even around the seed: a tempo wandering fast (a turntable, a tape). The beats followed
    // from the seed's own kick instead, stage 5; when they can't be either, said so)
    let bent = null;
    if (!lines.length) {
      { const i = near(ev.Kt, a, 0.015), t = i >= 0 ? hitStart(hits, ev.Kt[i], 1, 0.012) : null; bent = bendOf(hits, 1, ev, 0, t != null ? t : a, P, kLo, kHi, dur); }
      if (!bent) return { ...none('few'), bpm: Math.round(60 / P * 100) / 100 };
      const ks = bent.obs.map(o => o[0]), ts = bent.obs.map(o => o[1]);
      lines.push({ row: bent.row, ks, ts, fit: { slope: bent.P, icpt: bent.map.timeAt(0), m: ks.length }, on: bent.on, kicks: ks.length / (ks[ks.length - 1] - ks[0] + 1), rms: bent.rms });
    }
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
    // -- 4b. pins where the line doesn't hold (stage 5): the beats followed out from the seed window, where the line
    // is known, and the fewest pins that hold them within 2 ms. The grid is then those pins (its BPM their mean);
    // the 1 and the sections are found on it. Not done when they can't be followed over most of the drums.
    if (drift && !bent) {
      // (from a kick on the line nearest the seed window's middle: one of the line's own hits, where it holds)
      const km = kSeedOf(icpt, period, seed);
      let k0 = km, t0 = null, bd = 1e9;
      for (let i = 0; i < L.ks.length; i++) {
        if (Math.abs(L.ts[i] - (L.fit.icpt + L.fit.slope * L.ks[i])) > 0.002 || Math.abs(L.ks[i] - km) >= bd) continue;
        const j = near(ev.Kt, L.ts[i], 0.004);
        if (j >= 0 && ev.kw[j] >= 0.36) { bd = Math.abs(L.ks[i] - km); k0 = L.ks[i]; t0 = L.ts[i]; }
      }
      if (t0 != null) bent = bendOf(hits, L.row, ev, k0, t0, L.fit.slope, kLo - 8, kHi + 8, dur);
      // (the beats followed all on the straight line after all, within 3 ms: the tempo is constant, the windows were
      // wrong. The line, unmarked)
      if (bent) {
        let on = 0;
        for (const [k, t] of bent.obs) if (Math.abs(t - (L.fit.icpt + L.fit.slope * k)) <= 0.003) on++;
        if (on >= 0.97 * bent.obs.length) {
          bent = null; drift = null; parts = null; period = L.fit.slope; icpt = L.fit.icpt;
          why.splice(why.findIndex(w => w.code === 'drift' || w.code === 'jump'), 1);
        }
      }
    } else if (bent && !drift) {
      drift = { kind: 'wander', at: null, windows: 0 };
      why.push({ code: 'drift', at: null, parts });
    }
    // -- 4c. a band's tempo (stage 6a): the beat path through all the drums, its smooth curve, its pins. Taken when it
    // sits on the drums' own beats clearly better than the line (or stage 5's pins) does: a steady track keeps its line
    // (not tried where the line holds tightly, most of its beats' hits within 2 ms of it: no band plays that steadily)
    let live = null, liveDoubt = null;
    if (!opts.noLive && (drift || bent || L.on < 0.6)) {
      // (from the seed window's own grid, right there to a few ms: a kick beat, numbered 0 as the line's beats are)
      // (each window's own grid, where it reads this tempo well: in our beats, a half-time reading counted double)
      const mul = Pp / P, prior = pick.list.filter(c => c.score >= 0.3 * seed.score).map(c => [c.t0, c.t1, c.a + c.even * c.P, c.P / mul]);
      // (each window's own tempo, near this one: its best reading within 8 %, where it reads one well)
      const local = [];
      for (const w of wins) {
        let b = null;
        for (const c of w) { const Pc = c.P / mul; if (Math.abs(Math.log(Pc / P)) < 0.075 && (!b || c.score > b.score)) b = { ...c, Pc }; }
        if (b && b.score >= 0.3 * seed.score) local.push([(b.t0 + b.t1) / 2, b.Pc]);
      }
      const lv = liveOf(hits, ev, L.row, 0, a, P, dur, seed.t0, seed.t1, prior, local);
      if (lv) {
        // (where the drums give too little to follow: said whichever grid is kept, a band's or stage 5's)
        if (lv.doubt.length) liveDoubt = lv.doubt.map(([a0, b0]) => ({ t0: lv.map.timeAt(a0), t1: lv.map.timeAt(b0), why: 'drums' }));
        const eL = evidErr(lv.evid, bent ? bent.map.beatAt : t => (t - icpt) / period), eV = evidErr(lv.evid, lv.map.beatAt);
        // (how far the curve goes from the straight line at all, its own offset aside)
        const dev = lv.obs.map(([k, t]) => { const u = (t - L.fit.icpt) / L.fit.slope; return (u - Math.round(u)) * L.fit.slope; }).sort((x, y) => x - y), md = dev[dev.length >> 1];
        const far = Math.max(Math.abs(dev[0] - md), Math.abs(dev[dev.length - 1] - md)) * 1000;
        if (opts.debug) live = { nres: lv.nres, evid: lv.evid, eLine: eL, eLive: eV, far, pins: lv.pins.length, doubt: lv.doubt.length, off: lv.off, fw: lv.fw, sure: lv.sure, H: lv.H, used: false, curve: lv.curve };
        // (the line stays while it is within 6 ms of the drums everywhere: a steady track, or a band so tight that
        // following it changes nothing)
        if ((drift || bent || far > 3) && eV + 1 < eL && (bent || eL > 6)) {
          if (live) live.used = true;
          if (!drift) { drift = { kind: 'live', at: null, windows: 0 }; why.push({ code: 'drift', at: null, parts }); }
          drift.kind = drift.kind === 'jump' ? 'live' : drift.kind;
          bent = lv;
        }
      }
    }
    if (bent) { period = bent.P; icpt = bent.map.timeAt(0); }

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
    // the beats: beat k (as counted from the seed) at beatT(k); on the line when the tempo is constant, on the
    // pins when it wanders
    const beatT = bent ? bent.map.timeAt : k => icpt + k * period;
    const kA = bent ? Math.ceil(bent.map.beatAt(0)) - 2 : kLo, kB = bent ? Math.floor(bent.map.beatAt(dur)) + 2 : kHi;

    // -- 6. the 1
    const one = findOne(ev, peaks, opts.bass, beatT, kA, kB);
    const bar0 = beatT(one.k1);
    const t0 = bar0 - Math.floor(bar0 / period) * period;

    // -- 7. trust
    if (rd.faint) why.push({ code: 'faint' });
    if (margin < 1.15 && second) why.push({ code: 'tempo2', bpm: Math.round(second.bpm * 10) / 10 });
    if (voters >= 3 && agree / voters < 0.6) {
      const names = ['start', 'middle', 'end'];
      const odd = partsOf.map((p, i) => { const d = p.filter(Boolean); return d.length > p.length / 2 ? { part: names[i], bpm: Math.round(d.sort((x, y) => x - y)[d.length >> 1] * 10) / 10 } : null; }).filter(Boolean);
      why.push({ code: 'parts', odd });
    }
    if (L.fit.m < 24) why.push({ code: 'few', n: L.fit.m });
    if (!drift && (L.rms > 1.5 || L.on < 0.5)) why.push({ code: 'loose', ms: Math.round(L.rms * 10) / 10, on: Math.round(L.on * 100) });
    if (!one.ok) why.push({ code: 'one', by: one.by });
    // (pinned: the grid follows the tempo now; said so, the pins to be looked at once, in place of "drifts")
    if (bent && !bent.live) {
      const i = why.findIndex(w => w.code === 'drift' || w.code === 'jump');
      const w = { code: 'pins', n: bent.pins.length, kind: drift.kind, at: drift.at, parts };
      if (i >= 0) why[i] = w; else why.push(w);
    }
    // (a band's tempo followed: not to check for that; only where it is doubtful, each such stretch, and a note)
    if (bent && bent.live) {
      const i = why.findIndex(w => w.code === 'drift' || w.code === 'jump');
      if (i >= 0) why.splice(i, 1);
      const f = why.findIndex(w => w.code === 'few'); if (f >= 0 && bent.sure >= 24) why.splice(f, 1);
      notes.push({ code: 'live', n: bent.pins.length });
      if (bent.doubt.length) why.push({ code: 'doubt', n: bent.doubt.length, at: bent.map.timeAt(bent.doubt[0][0]) });
    }
    const conf = { kicks: Math.round(L.kicks * 1000) / 1000, rms: Math.round(L.rms * 100) / 100, row: L.row, on: Math.round(L.on * 1000) / 1000, n: L.fit.m,
      margin: Math.round(Math.min(9, margin) * 100) / 100, agree: voters ? Math.round(agree / voters * 100) / 100 : null, score: Math.round(raw.agg * 100) / 100, bar: one.conf };
    const out = { v: GRID_V, bpm: 60 / period, period, t0, bar0, whole, exact: true, ok: !why.length, why, notes, conf, drift, parts,
      families: { kicks: ev.kicks, snares: ev.snares, hats: ev.hats }, sections: [] };
    // (the pins, their beats counted from the 1: the bar lines where b is a multiple of 4)
    if (bent) out.pins = bent.pins.map(([t, k]) => [t, k - one.k1]);
    // (stage 6a: where the drums give too little to follow the band, from a beat to a beat: s)
    if (bent && liveDoubt) out.doubt = liveDoubt;
    // -- 8. the structure: the sections, the phrase grid, the cue (on the grid just found)
    const st = analyzeStructure(ev, peaks, hits, bar0, period, dur, opts.debug, one.ok, out.ok, bent ? b => beatT(b + one.k1) : null);
    if (st) { out.sections = st.sections; out.cue = st.cue; out.phrase = st.phrase; if (opts.structure) out.structure = st; }
    // (for the test bench's close look: what was weighed)
    if (opts.debug) out.dbg = { clusters: clusters.map(c => ({ bpm: c.bpm, agg: c.agg, cK: c.cK, c: c.c, alt: c.alt, n: c.list.length })), seed: { bpm: seed.bpm, a: seed.a, t0: seed.t0, score: seed.score, c: seed.c, e: seed.e, alt: seed.alt, even: seed.even },
      lines: lines.map(l => ({ row: l.row, n: l.ks.length, m: l.fit.m, rms: l.rms, kicks: l.kicks, on: l.on })), live };
    return out;
  }

  // ---------- 8. the structure: the sections, the phrase grid, the cue ----------
  // On the grid found (bar 1 at bar0), each bar is described: its kicks, its snares and claps, its hats (per beat),
  // its level in the four bands of the waveform, and whether it is "on the grid" (its hits on the grid's 16ths, or
  // its sound rising and falling the same way bar after bar: a pad's chord struck on each bar line).
  // - Where the music changes: four bars after a bar line against the four before it (four bars: a sound that comes
  //   and goes every bar or every two bars is the same on both sides, and makes no change). The peaks are the
  //   changes.
  // - The phrase grid: which bars counted in eights (0 to 7) the changes land on, the strong ones weighing most.
  // - The sections: from change to change; named by what plays (intro before the drums, "kicks in" where they come,
  //   break without them, drop when they come back, outro at the end, main otherwise).
  // - The cue, by the user's rule: from the first clear phrase start (where the drums come in, on the phrase grid),
  //   back by 64 bars while they fit, then 32, 16, 8, 4, never into a free intro off the grid; if not even 4 bars
  //   fit, the first kick. With the phrase grid unsure, two more candidates (from the next best counts).
  // -> { sections: [{ t, k, c }], phrase: { o, conf }, cue: { t, ok, why, alts: [t] }, bars: n } or null
  const SEC_NAMES = ['intro', 'kicks', 'main', 'break', 'drop', 'outro'];
  // noBeat: found on a grid the beat analysis didn't give (it found no steady beat: the track's older grid, a BPM
  // typed, yours): what plays is then told by the low end's level, not by kicks (the low hits of a track without
  // drums are its bass's notes)
  function analyzeStructure(ev, peaks, hits, one, period, dur, debug, oneOk, gridOk, beatTime, noBeat) {
    // (bar 0 here: the first bar line at or after 0:00; on a grid of pins (beatTime: beat b from the 1 -> s), its
    // bar lines, each bar cut in sixteenths of its own length's average)
    const B = 4 * period;
    let bar0 = one - Math.floor(one / B + 1e-9) * B, n = Math.floor((dur - bar0) / B + 1e-6), bt = k => bar0 + k * B;
    if (beatTime) {
      let m0 = Math.ceil(-(one / B)) - 2;
      while (beatTime(4 * m0) < -1e-9) m0++;
      bt = k => beatTime(4 * (m0 + k)); bar0 = bt(0);
      n = 0; while (bt(n + 1) <= dur + 1e-6) n++;
    }
    if (!(period > 0) || n < 16) return null;
    const pd = peaks.data, pn = peaks.n;
    const count = (T, W, thr, a, b) => { let c = 0; for (let i = lower(T, a); i < T.length && T[i] < b; i++) if (W[i] >= thr) c++; return c; };
    const K = new Float32Array(n), S = new Float32Array(n), H = new Float32Array(n), E = [0, 1, 2, 3].map(() => new Float32Array(n));
    const down = new Uint8Array(n), grid = new Uint8Array(n), hitsOn = new Float32Array(n), comb = new Float32Array(n), env = [];
    const combOn = [new Float32Array(n), new Float32Array(n)], combOff = [new Float32Array(n), new Float32Array(n)];
    // (every hit, the hats' row too: the grid analysis reads the kicks' and snares' rows only)
    const HT = rowOnsets(hits.data, hits.n, 2, 24).t, allT = Float64Array.from([...ev.allT, ...HT]).sort();
    const eighth = period / 4;
    for (let k = 0; k < n; k++) {
      const a = bt(k) - 0.03, b = bt(k + 1) - 0.03;
      K[k] = count(ev.Kt, ev.kw, 0.09, a, b) / 4;
      S[k] = count(ev.St, ev.sw, 0.3, a, b) / 4;
      H[k] = count(ev.St, ev.hw, 0.01, a, b) / 8;
      down[k] = (near(ev.Kt, bt(k), 0.03) >= 0 && ev.kw[near(ev.Kt, bt(k), 0.03)] >= 0.36) || (near(ev.St, bt(k), 0.03) >= 0 && ev.sw[near(ev.St, bt(k), 0.03)] >= 0.3) ? 1 : 0;
      // the waveform's four bands over the bar, and its loudness in 16 steps (for "the same every bar")
      const fa = Math.max(0, Math.floor(bt(k) * PK_RATE)), fb = Math.min(pn, Math.floor(bt(k + 1) * PK_RATE));
      const steps = new Float32Array(16);
      for (let j = 0; j < 4; j++) { let s2 = 0; for (let f = fa; f < fb; f++) s2 += pd[4 * f + j]; E[j][k] = s2 / Math.max(1, fb - fa); }
      for (let q = 0; q < 16; q++) { const f0 = Math.floor((bt(k) + q * B / 16) * PK_RATE), f1 = Math.floor((bt(k) + (q + 1) * B / 16) * PK_RATE); let s2 = 0; for (let f = f0; f < f1 && f < pn; f++) s2 += pd[4 * f]; steps[q] = s2 / Math.max(1, f1 - f0); }
      env.push(steps);
      // hits on the grid: the share of the bar's hits (of any weight: a hat counts) within 20 ms of a 16th
      let on = 0, all = 0;
      for (let i = lower(allT, bt(k) - 0.02); i < allT.length && allT[i] < bt(k + 1) - 0.02; i++) {
        const x = (allT[i] - bt(k)) / eighth, off = Math.abs(x - Math.round(x)) * eighth;
        all++; if (off <= 0.02) on++;
      }
      hitsOn[k] = all >= 6 ? on / all : -1;
      // and the waveform's highs (and its whole): louder on the grid's 16ths than halfway between them: quiet hats
      // the hits don't see, a shaker. (Pads, an ambient wash, loose noises: the same on and between.)
      for (const j of [3, 0]) {   // (kept apart, then read over two bars: a few loose hits don't make it)
        let onL = 0, offL = 0;
        for (let q = 0; q < 16; q++) {
          const f = Math.floor((bt(k) + q * B / 16) * PK_RATE), fm = Math.floor((bt(k) + (q + 0.5) * B / 16) * PK_RATE);
          // (the loudest of four frames at each: on the line, and halfway)
          let mx = 0, mo = 0; for (let x = -1; x <= 2; x++) { if (f + x >= 0 && f + x < pn) mx = Math.max(mx, pd[4 * (f + x) + j]); if (fm + x >= 0 && fm + x < pn) mo = Math.max(mo, pd[4 * (fm + x) + j]); }
          // (a line struck: clearly louder than halfway after it; a halfway point struck: the other way round)
          if (mx >= 8 && mx > 1.6 * mo + 2) onL++; else if (mo >= 8 && mo > 1.6 * mx + 2) offL++;
        }
        combOn[j >> 1][k] = onL; combOff[j >> 1][k] = offL;
      }
    }
    // (the same rise and fall as the next bar: a correlation over the 16 steps, with something to correlate)
    const same = (u, v) => { let mu = 0, mv = 0; for (let q = 0; q < 16; q++) { mu += u[q]; mv += v[q]; } mu /= 16; mv /= 16;
      let suv = 0, suu = 0, svv = 0; for (let q = 0; q < 16; q++) { suv += (u[q] - mu) * (v[q] - mv); suu += (u[q] - mu) ** 2; svv += (v[q] - mv) ** 2; }
      if (Math.sqrt(suu / 16) < 0.04 * mu + 0.6 || Math.sqrt(svv / 16) < 0.04 * mv + 0.6) return 0; return suv / Math.sqrt(suu * svv); };
    for (let k = 0; k < n; k++) for (let j = 0; j < 2; j++) {
      // (over two bars: 8 lines struck or more, three times the halfway points struck)
      const k2 = k + 1 < n ? k + 1 : k - 1, on2 = combOn[j][k] + combOn[j][k2], off2 = combOff[j][k] + combOff[j][k2];
      comb[k] = Math.max(comb[k], on2 >= 8 && on2 >= 3 * off2 && combOn[j][k] >= 3 && combOn[j][k] >= 2 * combOff[j][k] ? 2 : 0);   // (the bar itself struck too)
    }
    for (let k = 0; k < n; k++) {
      // (a bar like the next and that one like the one after it, or the same two bars on: a swell over two bars;
      //  forwards or backwards. Twice in a row, so a sound that wobbles at its own speed doesn't pass by chance)
      const rep2 = (j, d) => k + 2 * j * d >= 0 && k + 2 * j * d < n && same(env[k], env[k + j * d]) >= 0.6 && same(env[k + j * d], env[k + 2 * j * d]) >= 0.6;
      // (2: on the grid by its hits; 1: by its sound repeating only, which a free intro can do by chance)
      grid[k] = hitsOn[k] >= 0.7 || comb[k] >= 1.3 ? 2 : rep2(1, 1) || rep2(1, -1) || rep2(2, 1) || rep2(2, -1) ? 1 : 0;
    }
    // the bands to the track's own scale (their 95th percentile)
    const En = E.map(e => { const q = pct(Array.from(e), 0.95) || 1; return Float32Array.from(e, v => Math.min(1.5, v / q)); });
    // (drums: kicks on half the beats, or kicks and snares together; a broken beat leaves a bar without a kick
    // now and then, so a kick in the bar next to it counts)
    const kAt = k => k >= 0 && k < n ? K[k] : 0;
    // (a section's fullness: its level, its hats, its low end; an outro under 90 % of the section before it)
    const OR = 0.9, LV = k => En[0][k] + Math.min(1, H[k]) + En[1][k];
    // (no beat: a bar is full when its bass (the waveform's low band) is up from the track's quiet bars towards its loud
    // ones, by a third of the way or more; a track whose bass hardly changes is full all through)
    const lowAt = noBeat ? (() => { const a = Array.from(En[1]), p10 = pct(a, 0.1), p90 = pct(a, 0.9); return p90 - p10 < 0.25 ? -1 : p10 + 0.35 * (p90 - p10); })() : 0;
    const drums = noBeat ? k => En[1][k] >= lowAt : k => K[k] >= 0.45 || (K[k] + S[k] >= 0.5 && Math.max(K[k], kAt(k - 1), kAt(k + 1)) >= 0.2);
    // -- the changes
    const F = k => [2 * Math.min(1, K[k]), Math.min(1, S[k]), Math.min(1, H[k]), En[0][k], En[1][k], En[2][k], En[3][k]];
    const Fk = []; for (let k = 0; k < n; k++) Fk.push(F(k));
    const nov = new Float32Array(n);
    for (let b = 1; b < n; b++) {
      const w = Math.min(4, b, n - b);
      let v = 0;
      for (let j = 0; j < 7; j++) { let af = 0, be = 0; for (let i = 0; i < w; i++) { af += Fk[b + i][j]; be += Fk[b - 1 - i][j]; } v += Math.abs(af - be) / w; }
      nov[b] = v;
    }
    const nv = Array.from(nov.slice(1)).sort((x, y) => x - y), med = nv[nv.length >> 1], mad = nv.map(x => Math.abs(x - med)).sort((x, y) => x - y)[nv.length >> 1];
    const thr = Math.max(0.6, med + 3 * mad);   // (a loop with nothing changing: no sections)
    const peaksAt = [];
    for (let b = 2; b < n - 1; b++) {    // (not the first bar or the last: a fade, a tail)
      if (nov[b] < thr) continue;
      let top = true; for (let j = Math.max(1, b - 2); j <= Math.min(n - 1, b + 2); j++) if (j !== b && (nov[j] > nov[b] || (nov[j] === nov[b] && j < b))) top = false;
      if (top) peaksAt.push(b);
    }
    // -- the phrase grid: the count of eight the changes land on (their strength squared)
    const sc = new Float64Array(8);
    for (const b of peaksAt) sc[b % 8] += nov[b] * nov[b];
    const order = [0, 1, 2, 3, 4, 5, 6, 7].sort((x, y) => sc[y] - sc[x]);
    const o = order[0], conf = sc[order[1]] > 0 ? sc[o] / sc[order[1]] : sc[o] > 0 ? 9 : 0;
    // the section starts: the changes, each onto the phrase grid when a bar off it (and the change there nearly as
    // strong); a change between two others closer than 2 bars, the weaker one left out
    const starts = [];
    for (const b of peaksAt) {
      let c = b;
      for (const d of [-1, 1]) if ((b + d) % 8 === o && (b % 8) !== o && nov[b + d] >= 0.6 * nov[b]) c = b + d;
      if (!starts.includes(c)) starts.push(c);
    }
    // -- the drums come in: the first bar of four with drums, its 1 struck (a pickup's bar has drums only after it)
    let P = -1;
    for (let k = 0; k + 3 < n; k++) if (drums(k) && (noBeat || K[k] >= 0.2) && drums(k + 1) && drums(k + 2) && drums(k + 3)) { P = k; break; }
    // (a pickup: the bar has its drums after its 1 only, fewer than the next bar's)
    if (P >= 0 && P + 1 < n && !down[P] && down[P + 1] && K[P] + S[P] < 0.8 * (K[P + 1] + S[P + 1])) P++;
    if (P < 0) P = 0;
    // (the drums come in a bar or three before a clear change on the phrase count: that change is the phrase start,
    // the bars before it a lead-in)
    const P0 = P;
    if (conf >= 1.5 && P % 8 !== o) for (let d = 1; d <= 3; d++) {
      const b = P + d;
      if (b < n && b % 8 === o && peaksAt.includes(b) && nov[b] >= 1 && drums(b)) { P = b; break; }
    }
    if (P > 0 && !starts.includes(P)) starts.push(P);
    starts.sort((x, y) => x - y);
    // -- the sections, named
    const seg = [0, ...starts.filter(b => b > 0 && b < n)], sections = [];
    let level = 0;
    for (let i = 0; i < seg.length; i++) {
      const a = seg[i], b = i + 1 < seg.length ? seg[i + 1] : n;
      let dr = 0, lv = 0; for (let k = a; k < b; k++) { dr += drums(k) ? 1 : 0; lv += LV(k); }
      sections.push({ a, b, drums: dr / (b - a) >= 0.5, lv: lv / (b - a) });
      if (dr / (b - a) >= 0.5) level = Math.max(level, lv / (b - a));
    }
    let seen = false, afterBreak = false;
    for (let i = 0; i < sections.length; i++) {
      const x = sections[i];
      if (!x.drums) x.k = seen ? 'break' : 'intro';
      else if (!seen) x.k = i === 0 || noBeat ? 'main' : 'kicks';   // (no beat: the low end comes in, not kicks)
      else x.k = afterBreak ? 'drop' : 'main';
      if (x.drums) seen = true;
      afterBreak = !x.drums && seen;
    }
    // (the start: drums alone before the full sound, a DJ's intro, is the intro too)
    if (sections.length > 1 && sections[0].drums && sections[1].drums && sections[0].lv < OR * sections[1].lv) sections[0].k = 'intro';
    // (the end: the last section when it has no drums, or the drums with less around them than the section before;
    // back from there while each is thinner than the one before it)
    for (let i = sections.length - 1; i > 0; i--) {
      const x = sections[i], y = sections[i - 1];
      if ((!x.drums && i === sections.length - 1) || (x.drums && y.drums && x.lv < OR * y.lv)) x.k = 'outro'; else break;
    }
    // (an intro, a break or an outro is one block: its changes inside it, a riser, a sound leaving, are not new
    // sections)
    for (let i = sections.length - 1; i > 0; i--) {
      const x = sections[i], y = sections[i - 1];
      // (no beat: nor two of a kind a bar or two apart, the same change seen twice on a grid between its bars)
      if (x.k === y.k && (x.k === 'intro' || x.k === 'break' || x.k === 'outro' || (noBeat && y.b - y.a <= 2))) { y.b = x.b; sections.splice(i, 1); }
    }
    // -- the cue: from the drums' start, back as far as the grid holds the music (never into a free intro)
    // (one bar off the grid alone, a fill, a break of a bar, doesn't end it: two in a row do)
    let low = P;
    while (low > 0 && (grid[low - 1] || (low > 1 && grid[low - 2]))) low -= grid[low - 1] ? 1 : 2;
    const cueBar = from => { let c = from, went = false; for (const step of [64, 32, 16, 8, 4]) while (c - step >= low) { c -= step; went = true; } return { c, went }; };
    const firstKick = () => { if (noBeat) return bt(P); const i = ev.Kt.findIndex((t, j) => ev.kw[j] >= 0.36 && t >= bt(low) - 0.03); return i >= 0 ? ev.Kt[i] : bt(P); };
    const cueOf = from => { const r = cueBar(from); return !r.went && from - low >= 1 ? firstKick() : bt(r.c); };
    const why = [];
    if (conf < 1.3 && peaksAt.length >= 2) why.push('phrase');
    if (peaksAt.length < 2) why.push('flat');
    if (gridOk === false) why.push('grid');   // (the grid itself is unsure: a drift, a jump, loose playing)
    if (oneOk === false) why.push('one');   // (the grid's 1 unsure: the cue's bar line with it)
    // (an intro of 4 bars or more on the grid by its repeating sound alone: a pad on the tempo, or a free intro)
    { let soft = 0; for (let k = low; k < P; k++) if (grid[k] === 1) soft++; if (soft >= 4) why.push('intro'); }
    const t = cueOf(P), alts = [];
    if (P !== P0) { const t0 = cueOf(P0); if (Math.abs(t0 - t) > 0.01) alts.push(t0); }   // (the drums' own start)
    // (the other candidates: the drums' start moved onto the next best counts of four, and the first kick)
    for (const oo of order.slice(1, 3)) {
      if (sc[oo] <= 0) continue;
      let p2 = P; for (const d of [1, -1, 2, -2, 3, -3]) if (P + d >= 0 && (P + d) % 4 === oo % 4) { p2 = P + d; break; }
      const t2 = cueOf(p2); if (Math.abs(t2 - t) > 0.01 && !alts.some(x => Math.abs(x - t2) < 0.01)) alts.push(t2);
    }
    // (the drums' start: first among the others when the intro may be free)
    { const fk = firstKick(); if (Math.abs(fk - t) > 0.05 && !alts.some(x => Math.abs(x - fk) < 0.05)) { if (why.includes('intro')) alts.unshift(fk); else if (alts.length < 2) alts.push(fk); } }
    const r3 = x => Math.round(x * 1000) / 1000;
    const res = {
      bars: n, phrase: { o, conf: Math.round(Math.min(9, conf) * 100) / 100 },
      sections: sections.map(x => ({ t: r3(bt(x.a)), k: x.k, c: Math.round(Math.min(1, x.a === 0 ? 1 : nov[x.a] / (2 * thr)) * 100) / 100 })),
      cue: { t: r3(t), ok: !why.length, why, alts: alts.slice(0, 2).map(r3), low: r3(bt(low)) }
    };
    if (debug) res.dbg = { P, low, o, conf: res.phrase.conf, grid: Array.from(grid.slice(0, P + 2)).join(''), K: Array.from(K.slice(0, Math.min(P + 2, 30)), v => Math.round(v * 4)).join(''), S: Array.from(S.slice(0, Math.min(P + 2, 30)), v => Math.round(v * 4)).join(''), on: Array.from(hitsOn.slice(Math.max(0, P - 3), P + 2), v => Math.round(v * 10)).join(','), comb: Array.from(comb.slice(Math.max(0, P - 3), P + 2), v => Math.round(v * 100) / 100).join(','),
      peaks: peaksAt.map(b => [b, Math.round(nov[b] * 100) / 100]) };
    return res;
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
      case 'bassy': return 'its bass\'s notes are as sharp as kicks: the kicks told by their click';
      case 'faint': return 'the drums are sparse: the tempo is read from most of the track agreeing, not from a clear beat';
      case 'few': return `only ${r.n || 'a few'} beats have a hit to place the grid on`;
      case 'loose': return `its hits sit loosely on the grid (${r.ms} ms; ${r.on} % on it)`;
      case 'drift': return `the tempo is not constant${r.parts && r.parts[0] && r.parts[2] ? ` (${r.parts[0]} BPM at the start, ${r.parts[2]} at the end)` : ''}${r.at != null ? `: the grid holds only to about ${mmss(r.at)}` : ''}`;
      case 'jump': return `the grid does not hold for the whole track${r.at != null ? `: it slips around ${mmss(r.at)}` : ''}`;
      case 'pins': return `${r.kind === 'jump' ? `the grid slips${r.at != null ? ` (around ${mmss(r.at)})` : ''}` : `the tempo wanders${r.parts && r.parts[0] && r.parts[2] ? ` (${r.parts[0]} BPM at the start, ${r.parts[2]} at the end)` : ''}`}: ${r.n} pins placed to follow it, to look at once`;
      case 'doubt': return `the drums give too little to follow the band in ${r.n === 1 ? 'one place' : r.n + ' places'}${r.at != null ? ` (the first at ${mmss(r.at)})` : ''}: the grid is drawn straight across, to look at`;
      case 'live': return `played by a band: the grid follows its tempo with ${r.n} pins`;
      case 'one': return r.by === 'first' ? 'which beat is the 1 is a guess (the first kick)' : 'which beat is the 1 is not sure (its clues are weak or disagree)';
      case 'nonwhole': return `the tempo is not a whole number (${r.bpm}): a vinyl rip or played by hand`;
      case 'halftime': return 'half-time (the kick on 1, the snare on 3), counted double';
      case 'offbeat': return 'a kick on every beat, with an offbeat hit between';
      default: return r.code;
    }
  }

  // the structure as kept in a track's grid record (the app's and the server's): the sections and the cue, times
  // in ms; nothing when the analysis found none
  function structRecord(g) {
    const r3 = x => Math.round(x * 1000) / 1000, out = {};
    if (g && Array.isArray(g.sections) && g.sections.length) out.sec = g.sections.map(x => ({ t: r3(x.t), k: x.k, c: x.c }));
    // (stage 5: a grid that follows a wandering tempo, its pins [t s, beat from the 1])
    if (g && Array.isArray(g.pins) && g.pins.length > 1) out.pins = g.pins.map(([t, b]) => [Math.round(t * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]);
    // (stage 6a: where a band's grid is doubtful, [t0, t1] s)
    if (g && Array.isArray(g.doubt) && g.doubt.length) out.doubt = g.doubt.map(d => [r3(d.t0), r3(d.t1)]);
    if (g && g.cue && typeof g.cue.t === 'number') out.cue = { t: r3(g.cue.t), ok: g.cue.ok ? 1 : 0, why: g.cue.why || [], alts: (g.cue.alts || []).map(r3), ...(typeof g.cue.low === "number" ? { low: r3(g.cue.low) } : {}) };
    return out;
  }
  // The sections and the cue on a grid given, for a track the beat analysis found no steady beat in (the grid the
  // track has anyway: its older automatic one, a BPM typed, yours). grid: { one: a bar line (s), period (s),
  // beatTime?: beat b from that bar line -> s, for a grid of pins }. -> the record's { sec, cue } (the cue unsure), or {}
  function structureOn(peaks, hits, grid) {
    if (!hits || !hits.data || hits.rate !== HIT_RATE || !peaks || !peaks.data || !grid || !(grid.period > 0) || !isFinite(grid.one)) return {};
    const st = analyzeStructure(findEvents(hits, peaks), peaks, hits, grid.one, grid.period, hits.n / HIT_RATE, false, false, false, grid.beatTime || null, true);
    return st ? structRecord(st) : {};
  }
  return { GRID_V, analyzeGrid, bassBand, bassNotes, findEvents, hitStart, reasonText, structRecord, structureOn, SEC_NAMES };
});
