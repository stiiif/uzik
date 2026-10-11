// Walks the mounted music directory and produces `path` strings in EXACTLY the format the client
// generates for local Folder tracks, so server-computed analysis attaches to the same tags/notes/played
// history the client already has for these tracks — see collect() in player.js:
//   path = <the folder's own name as the client's picker sees it> + '/' + <relative path within it>
// joined with forward slashes regardless of OS. MUSIC_ROOT_NAME (env var) has to be set to match that
// folder's literal name — there's no way for the server to infer it, since a NAS directory's name and
// whatever name the browser's directory picker reports aren't guaranteed to be related (though in
// practice, picking the same directory gives it the same name).

const fs = require('fs/promises');
const path = require('path');

const AUDIO_RE = /\.(mp3|flac|m4a|aac|wav|ogg|opus)$/i; // mirrors AUDIO_RE in player.js exactly

// Async, using fs/promises rather than the *Sync filesystem calls this used originally. That wasn't a
// style choice — it was a real bug: Node is single-threaded for JS execution, and a fully synchronous
// recursive directory walk blocks the ENTIRE event loop for as long as it takes, including the HTTP
// server's ability to accept any connection at all (not just this one being slow — nothing else can run
// until the whole walk finishes). For a library of thousands of tracks on a NAS-mounted network share,
// that's easily minutes, and this ran at server startup BEFORE server.listen() — the server would be
// completely unreachable, not just slow, for the whole first scan, and then again on every periodic
// rescan afterward. The async version below yields to the event loop naturally between each directory
// read, so the server stays responsive throughout — same result, just no longer blocking.
async function scanMusicDir(musicDir, rootName) {
  const out = [];
  await walk(musicDir, rootName, out);
  return out;
}

async function walk(absDir, virtualPrefix, out) {
  let entries;
  try { entries = await fs.readdir(absDir, { withFileTypes: true }); }
  catch (e) { return; } // unreadable directory (permissions, transient NAS hiccup) — skip, don't crash the scan
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    const virtualPath = virtualPrefix + '/' + entry.name;
    if (entry.isDirectory()) {
      await walk(absPath, virtualPath, out);
    } else if (entry.isFile() && AUDIO_RE.test(entry.name)) {
      out.push({ path: virtualPath, absPath });
    }
  }
}

module.exports = { scanMusicDir, AUDIO_RE };
