// Where the server accepts connections from, and which web pages may read its answers.
//
// ALLOW_FROM  'home' (the default): only addresses of a home network: 10.x, 172.16–31.x, 192.168.x, this
//             machine (127.x), link-local (169.254.x), 100.64–127.x (Tailscale and other private VPNs) and
//             their IPv6 equivalents (fc00::/7, fe80::/10, ::1). A request from anywhere else is refused,
//             even with a valid key.
//             'any': from anywhere (a rented server, behind your own HTTPS proxy). Device keys still apply.
//             Or a comma-separated list of addresses / CIDR ranges, added to the home ones
//             (e.g. "203.0.113.7, 198.51.100.0/24").
// CORS: answers are readable by Uzikext itself (the Chrome extension, the app) and by the server's own
// status page, not by other web pages. CORS_ORIGINS adds origins.

function v4num(a) {
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inV4(addr, cidr) {
  const [base, bits = '32'] = cidr.split('/');
  const a = v4num(addr), b = v4num(base), n = Number(bits);
  if (a == null || b == null || !(n >= 0 && n <= 32)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
const HOME_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10'];

function normalize(addr) {
  let a = String(addr || '').toLowerCase();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  const z = a.indexOf('%'); if (z >= 0) a = a.slice(0, z);
  return a;
}
function isHome(addr) {
  const a = normalize(addr);
  if (a.includes('.')) return HOME_V4.some(c => inV4(a, c));
  if (a === '::1') return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a);
}

function createGuard({ allowFrom = 'home', corsOrigins = '' } = {}) {
  const mode = String(allowFrom || 'home').trim().toLowerCase();
  const extra = mode === 'home' || mode === 'any' ? [] : mode.split(/[\s,]+/).filter(Boolean);
  const allowed = addr => {
    if (mode === 'any') return true;
    if (isHome(addr)) return true;
    const a = normalize(addr);
    return extra.some(c => (c.includes('.') ? inV4(a, c.includes('/') ? c : c + '/32') : a === c));
  };
  const origins = String(corsOrigins || '').split(/[\s,]+/).filter(Boolean);
  const originOk = o => !!o && (/^chrome-extension:\/\/[a-p]{32}$/.test(o) || /^moz-extension:\/\//.test(o) ||
    o === 'tauri://localhost' || /^https?:\/\/tauri\.localhost$/.test(o) || origins.includes(o));
  const cors = req => {
    const o = req.headers.origin;
    const h = { Vary: 'Origin' };
    if (originOk(o)) Object.assign(h, { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Encoding, Range',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag' });
    return h;
  };
  return { allowed, cors, mode: mode === 'home' || mode === 'any' ? mode : 'list' };
}

module.exports = { createGuard, isHome, inV4, normalize };
