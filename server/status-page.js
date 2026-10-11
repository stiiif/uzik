// The server's own page, http://<server>:8787 — what it is, whether it's well, and the pairing code for the
// first device. Nothing on it needs a key; nothing private is on it.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function statusPage({ name, release, address, devices, update, analysis, music, telegram, firstRun }) {
  const rows = [
    ['Address to use in Uzikext', `<code>${esc(address)}</code>`],
    ['Version', esc(release) + (update && update.available ? ` · <b>update available: ${esc(update.latest)}</b>${update.url ? ` (<a href="${esc(update.url)}" target="_blank" rel="noopener">what's new</a>)` : ''}` : '')],
    ['Devices paired', String(devices)],
    ['Music folder', music],
    ['Background analysis', analysis],
    ['Telegram', telegram]
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1c1a;--muted:#6b6862;--line:#e3e0da;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1e1c;--text:#ecebe8;--muted:#a19d95;--line:#33312d;--accent:#fb923c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}
.row{display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}.k{color:var(--muted);min-width:190px}
code{font:14px ui-monospace,Consolas,monospace}h2{font-size:16px;margin:0 0 8px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--accent);color:#fff;cursor:pointer}
.code{font:600 40px ui-monospace,Consolas,monospace;letter-spacing:.18em;margin:12px 0 4px}.muted{color:var(--muted)}
@media (max-width:520px){.row{flex-direction:column;gap:0}.k{min-width:0}}
</style></head><body><main>
<h1>${esc(name)}</h1><p class="sub">Uzikext server: your tags, notes and analysis, kept in sync between your devices and backed up.</p>
<div class="card">${rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('')}</div>
<div class="card"><h2>Pair a device</h2>
<p class="muted">In Uzikext: ⋮ → Sync → <b>Find my server</b> (or type the address above), then enter the 6-digit code.</p>
<button id="get">Get a pairing code</button><div id="out"></div>
<p class="muted" style="margin-bottom:0">${firstRun ? 'No device is paired yet: the code is shown here.' : 'Devices are already paired: get the code from one of them (Sync panel → Devices → Add a device), or from this server\'s log (Container Station → this container → Logs), where this button writes it.'}</p></div>
<script>
document.getElementById('get').onclick = async () => {
  const out = document.getElementById('out');
  out.textContent = '…';
  try {
    const r = await fetch('/pair/page-code', { method: 'POST' }); const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    out.innerHTML = j.code ? '<div class="code">' + j.code + '</div><div class="muted">Valid 10 minutes, for one device.</div>'
      : '<p>A code is written in the server\\'s log (valid 10 minutes).</p>';
  } catch (e) { out.textContent = 'Could not get a code: ' + e.message; }
};
</script></main></body></html>`;
}

module.exports = { statusPage };
