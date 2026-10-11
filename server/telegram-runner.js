// The Telegram bridge inside the server's container: started, watched and restarted by the server, on this
// machine only (127.0.0.1), with a token of its own that never leaves the container. The devices reach it
// through the server (tg-proxy.js) with their device key.
//
// It needs a Telegram app ID, each user's own (https://my.telegram.org → API development tools): entered in
// Uzikext (Sync → On the server → Telegram), or TG_API_ID / TG_API_HASH in docker-compose.yml. Its data (the
// sign-in, the channels' cached lists) is in /data/telegram.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function startBridge({ dir, python, dataDir, port, token, apiId, apiHash, env = {}, log, onReady }) {
  const state = { running: false, starts: 0, lastExit: null, lastError: null, pid: null };
  let child = null, stopped = false, backoff = 3000, timer = null, startedAt = 0;
  fs.mkdirSync(dataDir, { recursive: true });

  function launch() {
    if (stopped) return;
    startedAt = Date.now(); state.starts++;
    child = spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port), '--workers', '1', '--no-access-log'], {
      cwd: dir, env: { ...process.env, ...env, SYNC_TOKEN: token, DATA_DIR: dataDir, PORT: String(port), TG_API_ID: String(apiId), TG_API_HASH: String(apiHash), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    state.running = true; state.pid = child.pid;
    const lines = buf => String(buf).split('\n').map(l => l.trimEnd()).filter(Boolean);
    const onOut = buf => { for (const l of lines(buf)) { if (/Uvicorn running/.test(l) && onReady) setTimeout(onReady, 300); if (/^(INFO|DEBUG):\s+(Started|Waiting|Application startup|Uvicorn running)/.test(l)) continue; log(l); if (/Error|Exception|Traceback/.test(l)) state.lastError = l.slice(0, 300); } };
    child.stdout.on('data', onOut); child.stderr.on('data', onOut);
    child.on('error', e => { state.lastError = e.message; log(`couldn't start: ${e.message}`); });
    child.on('exit', (code, sig) => {
      state.running = false; state.pid = null; state.lastExit = { code, sig, at: Date.now() };
      child = null;
      if (stopped) return;
      if (Date.now() - startedAt > 120000) backoff = 3000;   // it ran a while: start again quickly
      log(`stopped (${sig || 'code ' + code}); starting again in ${Math.round(backoff / 1000)} s`);
      timer = setTimeout(launch, backoff); timer.unref();
      backoff = Math.min(backoff * 2, 5 * 60 * 1000);
    });
  }
  launch();
  return {
    state: () => ({ ...state }),
    // stops it; resolves once it has exited (so a new one can take the port)
    stop: () => new Promise(resolve => {
      stopped = true; clearTimeout(timer);
      if (!child) return resolve();
      const c = child, t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
      c.once('exit', () => { clearTimeout(t); resolve(); });
      c.kill('SIGTERM');
    })
  };
}

// the bridge's files, when they're in the image
function bundledBridge(base) {
  const dir = path.join(base, 'telegram-bridge');
  return fs.existsSync(path.join(dir, 'app.py')) ? dir : null;
}

module.exports = { startBridge, bundledBridge };
