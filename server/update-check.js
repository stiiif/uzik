// "Update available": once a day the server looks at the releases of the GitHub repository its image is
// built from (UPDATE_REPO, set when the image is built; "off" to never look) for a newer server release
// (tags server-v<version>). It only tells: the Sync panel and the status page show it, nothing is updated by
// itself. (Updating: Container Station → the container → Recreate, or `docker compose pull && docker compose up -d`.)
const DAY = 24 * 60 * 60 * 1000;

const parse = v => String(v || '').replace(/^server-v|^v/, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
function newer(a, b) {   // a > b
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function startUpdateCheck({ repo, current, log }) {
  const state = { repo: repo || null, current, latest: null, url: null, checkedAt: 0, error: null, available: false };
  if (!repo || repo === 'off' || typeof fetch !== 'function') return { state: () => ({ ...state }) };
  async function check() {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'uzikext-server' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      const rel = (Array.isArray(list) ? list : []).filter(x => !x.draft && !x.prerelease && /^server-v\d/.test(x.tag_name || ''))
        .sort((a, b) => (newer(a.tag_name, b.tag_name) ? -1 : newer(b.tag_name, a.tag_name) ? 1 : 0))[0];
      Object.assign(state, { checkedAt: Date.now(), error: null });
      if (rel) {
        state.latest = rel.tag_name.replace(/^server-v/, ''); state.url = rel.html_url;
        state.available = newer(state.latest, current);
        if (state.available) log(`Update available: ${state.latest} (this is ${current}): ${rel.html_url}`);
      }
    } catch (e) { Object.assign(state, { checkedAt: Date.now(), error: e.message }); }
  }
  setTimeout(check, 30 * 1000).unref();
  setInterval(check, DAY).unref();
  return { state: () => ({ ...state }), check };
}

module.exports = { startUpdateCheck, newer };
