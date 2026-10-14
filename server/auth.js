// Who may use the server: devices paired with a 6-digit code, each with its own key.
//
//   A device key   uzk1.<device id>.<secret>   made once, at pairing, and given to that device only. The
//                  server keeps only a keyed hash of it (HMAC with the server's own secret), so the database
//                  alone can't be used to sign in. Removing a device (⋮ → Sync → Devices) ends its access
//                  at once.
//   A pairing code 6 digits, valid 10 minutes, used once. Made by an already paired device ("Add a device"),
//                  or on the server's status page while no device is paired yet (a fresh server), or, after
//                  that, written in the container's log. 5 wrong codes in a row close pairing for a minute
//                  and cancel the codes then open: a code can't be guessed.
//   The old shared token (SYNC_TOKEN), when it's set: still accepted until it's switched off in the Sync
//                  panel. A device that uses it gets a key of its own by itself (POST /pair/upgrade).
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILS = 5, LOCK_MS = 60 * 1000;
const SEEN_EVERY_MS = 60 * 1000;

function createAuth({ db, getInfo, setInfo, legacyToken, log }) {
  db.exec(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, key_hash TEXT NOT NULL,
    created INTEGER NOT NULL, last_seen INTEGER, last_ip TEXT, via TEXT
  )`);
  let secret = getInfo('server_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setInfo('server_secret', secret); }
  const hashKey = k => crypto.createHmac('sha256', secret).update(String(k)).digest('hex');
  const st = {
    get: db.prepare('SELECT * FROM devices WHERE id=?'),
    all: db.prepare('SELECT id, name, platform, created, last_seen, last_ip, via FROM devices ORDER BY created'),
    add: db.prepare('INSERT INTO devices (id,name,platform,key_hash,created,last_seen,last_ip,via) VALUES (?,?,?,?,?,?,?,?)'),
    del: db.prepare('DELETE FROM devices WHERE id=?'),
    rename: db.prepare('UPDATE devices SET name=? WHERE id=?'),
    seen: db.prepare('UPDATE devices SET last_seen=?, last_ip=? WHERE id=?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM devices')
  };
  const seenAt = new Map();
  const codes = new Map();   // code -> { expires, by }
  let fails = 0, lockedUntil = 0;

  const legacyOn = () => !!legacyToken && getInfo('legacy_token') !== 'off';
  const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const cleanName = n => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Unnamed device';

  // -> { kind: 'device', device } | { kind: 'legacy' } | null
  function check(token, ip) {
    if (!token) return null;
    const m = /^uzk1\.([0-9a-f]{12})\.([A-Za-z0-9_-]{20,})$/.exec(token);
    if (m) {
      const d = st.get.get(m[1]);
      if (!d || !same(hashKey(token), d.key_hash)) return null;
      const now = Date.now();
      if (now - (seenAt.get(d.id) || 0) > SEEN_EVERY_MS) { seenAt.set(d.id, now); try { st.seen.run(now, ip || null, d.id); } catch (e) {} }
      return { kind: 'device', device: { id: d.id, name: d.name } };
    }
    if (legacyOn() && same(token, legacyToken)) return { kind: 'legacy' };
    return null;
  }

  function newDevice(name, platform, via, ip) {
    const id = crypto.randomBytes(6).toString('hex');
    const key = `uzk1.${id}.${crypto.randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    st.add.run(id, cleanName(name), String(platform || '').slice(0, 40) || null, hashKey(key), now, now, ip || null, via);
    seenAt.set(id, now);
    log(`Device paired: "${cleanName(name)}" (${id}, ${via})`);
    return { deviceId: id, key };
  }

  function sweep() { const now = Date.now(); for (const [c, r] of codes) if (r.expires <= now) codes.delete(c); }

  // a new pairing code (by: a device id, 'page' or 'log')
  function makeCode(by) {
    sweep();
    while (codes.size >= 5) codes.delete(codes.keys().next().value);   // (at most 5 open at once: the oldest goes)
    let code;
    do { code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (codes.has(code));
    const expires = Date.now() + CODE_TTL_MS;
    codes.set(code, { expires, by });
    return { code, expires };
  }

  // pairs with a code -> { deviceId, key } or throws (err.status)
  function pair(code, name, platform, ip) {
    sweep();
    const now = Date.now();
    if (now < lockedUntil) { const e = new Error(`too many wrong codes: try again in ${Math.ceil((lockedUntil - now) / 1000)} s`); e.status = 429; throw e; }
    const c = String(code || '').replace(/\D/g, '');
    let hit = null;
    for (const k of codes.keys()) if (same(k, c.padEnd(6, 'x').slice(0, 6))) hit = k;
    if (!hit || c.length !== 6) {
      fails++;
      if (fails >= MAX_FAILS) {
        fails = 0; lockedUntil = now + LOCK_MS; codes.clear();
        log('Pairing: 5 wrong codes in a row. Pairing closed for a minute, the open codes are cancelled.');
      }
      const e = new Error('wrong or expired code'); e.status = 403; throw e;
    }
    codes.delete(hit); fails = 0;
    return newDevice(name, platform, 'code', ip);
  }

  // a device using the old shared token gets a key of its own
  function upgrade(name, platform, ip) { return newDevice(name, platform, 'token', ip); }
  // the Uzikext app this server runs in pairs itself (POST /local/pair, with the app's admin key)
  function local(name, platform) { return newDevice(name, platform, 'this computer', '127.0.0.1'); }

  return {
    check, pair, upgrade, local, makeCode,
    deviceCount: () => st.count.get().n,
    list: () => st.all.all(),
    remove: id => st.del.run(String(id)).changes > 0,
    rename: (id, name) => st.rename.run(cleanName(name), String(id)).changes > 0,
    legacy: () => (!legacyToken ? 'unset' : legacyOn() ? 'on' : 'off'),
    setLegacy: on => setInfo('legacy_token', on ? 'on' : 'off'),
    openCodes: () => { sweep(); return codes.size; }
  };
}

module.exports = { createAuth, CODE_TTL_MS };
