// The server's own settings, changed from Uzikext's settings and kept in the database (table info, key
// server_settings). The environment variables (docker-compose.yml) only give the starting values: what's set
// in Uzikext's settings wins over them.
const fs = require('fs');
const path = require('path');

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function createSettings({ getInfo, setInfo, defaults }) {
  let stored = {};
  try { stored = JSON.parse(getInfo('server_settings') || '{}') || {}; } catch (e) { stored = {}; }
  const listeners = [];

  function effective() {
    const d = defaults, s = stored;
    const a = s.analysis || {}, b = s.backups || {}, k = b.keep || {}, m = s.music || {};
    return {
      name: s.name || d.name,
      analysis: {
        concurrency: clamp(a.concurrency, 1, 8, d.analysis.concurrency),
        paceMs: clamp(a.paceMs, 200, 60000, d.analysis.paceMs),
        maxDurationSec: clamp(a.maxDurationSec, 0, 6 * 3600, d.analysis.maxDurationSec),
        rescanMs: d.analysis.rescanMs
      },
      backups: {
        hourly: b.hourly == null ? d.backups.hourly : !!b.hourly,
        daily: b.daily == null ? d.backups.daily : !!b.daily,
        keep: Object.fromEntries(Object.entries(d.backups.keep).map(([key, v]) => [key, clamp(k[key], 0, 1000, v)])),
        copyDir: b.copyDir == null ? d.backups.copyDir : String(b.copyDir),
        hourlyMs: d.backups.hourlyMs, dailyMs: d.backups.dailyMs
      },
      // the Telegram app ID (each user's own); the hash is never sent back to the devices (server.js)
      telegram: {
        apiId: (s.telegram && s.telegram.apiId) || d.telegram.apiId || '',
        apiHash: (s.telegram && s.telegram.apiHash) || d.telegram.apiHash || '',
        from: s.telegram && s.telegram.apiId ? 'panel' : d.telegram.apiId ? 'env' : null
      },
      music: {
        dir: d.music.dir,
        // [{ name, dir }] chosen by hand in Uzikext's settings, or null: found by itself (music-match.js)
        roots: Array.isArray(m.roots) ? m.roots : d.music.roots
      }
    };
  }

  // a change from Uzikext's settings (only the parts given): validated, stored, applied
  // trusted: from the Uzikext app the server runs in (any folder of that computer may be used)
  function update(patch, { trusted = false } = {}) {
    const p = patch || {}, next = JSON.parse(JSON.stringify(stored));
    if (typeof p.name === 'string') next.name = p.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || undefined;
    if (p.analysis && typeof p.analysis === 'object') {
      next.analysis = next.analysis || {};
      for (const key of ['concurrency', 'paceMs', 'maxDurationSec']) if (p.analysis[key] != null && Number.isFinite(Number(p.analysis[key]))) next.analysis[key] = Number(p.analysis[key]);
    }
    if (p.backups && typeof p.backups === 'object') {
      next.backups = next.backups || {};
      for (const key of ['hourly', 'daily']) if (typeof p.backups[key] === 'boolean') next.backups[key] = p.backups[key];
      if (p.backups.keep && typeof p.backups.keep === 'object') {
        next.backups.keep = next.backups.keep || {};
        for (const key of Object.keys(defaults.backups.keep)) if (p.backups.keep[key] != null && Number.isFinite(Number(p.backups.keep[key]))) next.backups.keep[key] = Number(p.backups.keep[key]);
      }
      if (p.backups.copyDir !== undefined) {
        const c = p.backups.copyDir == null ? '' : String(p.backups.copyDir);
        if (c && !trusted && !mounts(defaults.notCopy).some(x => x.path === c && x.writable)) throw new Error(`${c} isn't one of the folders the server sees`);
        if (c && trusted && !fs.existsSync(c)) throw new Error(`${c} isn't there`);
        next.backups.copyDir = c;
      }
    }
    if (p.telegram && typeof p.telegram === 'object') {
      if (p.telegram.apiId == null && p.telegram.apiHash == null) delete next.telegram;
      else {
        const id = String(p.telegram.apiId || '').trim(), hash = String(p.telegram.apiHash || '').trim().toLowerCase();
        if (!/^\d{3,12}$/.test(id)) throw new Error('the api_id is a number (my.telegram.org → API development tools)');
        if (!/^[0-9a-f]{32}$/.test(hash)) throw new Error('the api_hash is 32 letters and digits (my.telegram.org → API development tools)');
        next.telegram = { apiId: id, apiHash: hash };
      }
    }
    if (p.music && typeof p.music === 'object' && 'roots' in p.music) {
      if (p.music.roots == null) delete (next.music = next.music || {}).roots;
      else {
        if (!Array.isArray(p.music.roots)) throw new Error('music.roots: a list');
        const base = path.resolve(defaults.music.dir || '/music');
        const roots = p.music.roots.map(r => ({ name: String(r.name || '').trim(), dir: path.resolve(String(r.dir || '')) }));
        for (const r of roots) {
          if (!r.name || r.name.includes('/')) throw new Error('a music folder needs its name, as the devices show it');
          if (!trusted && r.dir !== base && !r.dir.startsWith(base + path.sep)) throw new Error(`${r.dir} isn't inside ${base}`);
        }
        (next.music = next.music || {}).roots = roots;
      }
    }
    const before = effective();
    stored = next;
    setInfo('server_settings', JSON.stringify(stored));
    const after = effective();
    for (const fn of listeners) { try { fn(after, before); } catch (e) { console.error(e); } }
    return after;
  }

  return { effective, update, onChange: fn => listeners.push(fn), stored: () => stored };
}

// Folders the container has been given (its mounts), for the backups' copy: Uzikext's settings offer these.
function mounts(exclude = []) {
  let text = '';
  try { text = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch (e) { return []; }
  const skip = /^\/(proc|sys|dev|etc|run|tmp|usr|lib|bin|sbin|var|root|home)(\/|$)|^\/app(\/|$)|^\/$/;
  const out = [], seen = new Set();
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 5) continue;
    const mp = f[4].replace(/\\040/g, ' ');
    if (skip.test(mp) || seen.has(mp) || exclude.some(x => x && (mp === x || mp.startsWith(x + '/')))) continue;
    seen.add(mp);
    let writable = false;
    try { fs.accessSync(mp, fs.constants.W_OK); writable = !/(^|,)ro(,|$)/.test(f[5] || ''); } catch (e) {}
    try { if (!fs.statSync(mp).isDirectory()) continue; } catch (e) { continue; }
    out.push({ path: mp, writable });
  }
  return out;
}

module.exports = { createSettings, mounts };
