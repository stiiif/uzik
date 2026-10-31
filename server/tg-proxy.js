// Telegram through the sync server: the devices reach the Telegram bridge (built in: telegram-runner.js; or
// elsewhere: TELEGRAM_BRIDGE_URL) through this server (/tg/…), with their own device key, so Uzikext needs one
// address and one pairing for everything. The bridge's own token never leaves the server.
const http = require('http');
const https = require('https');

const PASS_REQ = ['range', 'content-type', 'content-encoding', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding'];
const PASS_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-encoding', 'content-disposition'];

function createTgProxy({ url, token, log }) {
  let off, base, lib;
  // signedOut: why Telegram ended the bridge's session (it's running, not signed in: sign in again)
  const state = { configured: false, url: null, reachable: null, authorized: null, signedOut: null, checkedAt: 0, error: null };
  // where the bridge is (and its token); changed when the bridge is started or stopped
  function reconfigure(next) {
    url = next.url; token = next.token;
    off = !url || url === 'off';
    base = off ? null : new URL(url.replace(/\/+$/, '') + '/');
    lib = base && base.protocol === 'https:' ? https : http;
    Object.assign(state, { configured: !off, url: off ? null : base.origin, reachable: null, authorized: null, signedOut: null, error: null });
  }
  reconfigure({ url, token });

  function request(method, pathAndQuery, headers, timeoutMs) {
    // always on the bridge: a path that looks like an address ("/tg/http://elsewhere") stays a path
    const target = new URL(base.origin + '/' + String(pathAndQuery).replace(/^[\/\\]+/, ''));
    if (target.origin !== base.origin) throw new Error('bad path');
    target.searchParams.delete('token');
    if (token) target.searchParams.set('token', token);
    return lib.request(target, { method, headers: { ...headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, timeout: timeoutMs });
  }

  // is the bridge there, and signed in?
  function probe() {
    if (off) return Promise.resolve(state);
    return new Promise(resolve => {
      const req = request('GET', '/api/status', { accept: 'application/json' }, 5000);
      req.on('response', res => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          let j = null; try { j = JSON.parse(body); } catch (e) {}
          Object.assign(state, { reachable: res.statusCode < 500, authorized: j ? !!j.authorized : null, signedOut: (j && j.signedOut) || null, checkedAt: Date.now(),
            error: res.statusCode === 401 ? "the bridge refused this server's token (TELEGRAM_BRIDGE_TOKEN = the bridge's SYNC_TOKEN)" : res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null });
          resolve(state);
        });
      });
      req.on('timeout', () => req.destroy(new Error('no answer')));
      req.on('error', e => { Object.assign(state, { reachable: false, authorized: null, checkedAt: Date.now(), error: e.code === 'ENOTFOUND' ? `${base.host} not found` : e.code === 'ECONNREFUSED' ? 'not running (starting?)' : e.message }); resolve(state); });
      req.end();
    });
  }
  // checked every 5 minutes, every 20 s while it isn't there (starting, restarting)
  const loop = () => probe().then(() => { const t = setTimeout(loop, state.reachable && !state.error ? 5 * 60 * 1000 : 20000); t.unref(); });
  setTimeout(loop, 2000).unref();

  // forwards one request (/tg/<path>) to the bridge, streaming both ways
  function forward(req, res, rest, cors) {
    if (off) { res.writeHead(404, { 'Content-Type': 'application/json', ...cors }); return res.end('{"error":"Telegram is off on this server"}'); }
    const headers = {};
    for (const h of PASS_REQ) if (req.headers[h]) headers[h] = req.headers[h];
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    let up;
    try { up = request(req.method, rest, headers, 120000); }
    catch (e) { res.writeHead(400, { 'Content-Type': 'application/json', ...cors }); return res.end('{"error":"bad path"}'); }
    up.on('response', r => {
      const h = { ...cors };
      for (const k of PASS_RES) if (r.headers[k] != null) h[k] = r.headers[k];
      res.writeHead(r.statusCode, h);
      r.pipe(res);
      // (signed in or out: the state again at once; Telegram ending the session shows as a 503 on any call)
      if (/^\/api\/(sign_in|status|send_code|logout)/.test(rest) || r.statusCode === 503) r.on('end', () => setTimeout(probe, 500));
    });
    up.on('timeout', () => up.destroy(new Error('the bridge took too long')));
    up.on('error', e => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: `Telegram bridge: ${e.message}` }));
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  return { forward, probe, reconfigure, state: () => ({ ...state }) };
}

module.exports = { createTgProxy };
