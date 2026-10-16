"""
Telegram bridge for Uzikext.

Keeps a cached library of the audio posted in the Telegram channels ticked on the admin page,
refreshes it every REFRESH_MINUTES and serves it on the LAN:

  /                         admin page (Telegram login, channel selection, browse / play)
  /health                   status, no auth
  /api/manifest             the track list Uzikext reads (stable uid + browsable path + metadata)
  /stream/{channel}/{msg}   the audio itself, with HTTP Range (play, seek, download)

Everything except / and /health needs SYNC_TOKEN, as `Authorization: Bearer <token>` or `?token=<token>`
(the query form is what <audio> elements use, since they can't send headers).
"""
import asyncio, gzip, hashlib, hmac, json, os, re, shutil, tempfile, threading, time, zipfile
from collections import Counter, OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

# Telegram's encryption in C, not Python: Telethon uses cryptg when it's installed, else the system's OpenSSL
# (found through ctypes.util.find_library, which can't see it on Alpine Linux, the server's image: helped here),
# else plain Python (slow: a few hundred KB/s, and busy).
import ctypes, ctypes.util as _ctu, sys
_find_library = _ctu.find_library
def _find_library_too(name):
    found = _find_library(name)
    if found or name != "ssl":
        return found
    # (only a library that really has the AES functions Telethon calls: libcrypto, or libssl through it)
    dirs = ["/usr/lib", "/lib", "/usr/local/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", os.path.dirname(sys.executable), os.path.join(sys.base_prefix, "DLLs")]
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if re.match(r"lib(crypto|ssl)([-.].*)?\.(so(\.\d+)*|dll)$", f):
                try:
                    lib = ctypes.CDLL(os.path.join(d, f))
                    if hasattr(lib, "AES_ige_encrypt") and hasattr(lib, "AES_set_decrypt_key"):
                        return os.path.join(d, f)
                except OSError:
                    pass
    return None
_ctu.find_library = _find_library_too

from telethon import TelegramClient
from telethon.crypto import aes as _tl_aes
from telethon.errors import FloodWaitError, SessionPasswordNeededError
from telethon.tl.types import InputMessagesFilterDocument, InputMessagesFilterMusic


def env_int(name, default):
    v = os.environ.get(name, "").strip()
    return int(v) if v else default


API_ID = env_int("TG_API_ID", 0)
API_HASH = os.environ.get("TG_API_HASH", "").strip()
TOKEN = os.environ.get("SYNC_TOKEN", "").strip()
DATA_DIR = os.environ.get("DATA_DIR", "/data")
REFRESH_MINUTES = max(env_int("REFRESH_MINUTES", 60), 5)
SCAN_YEARS = env_int("SCAN_YEARS", 3)            # how far back a channel's FIRST scan goes; 0 = whole history
TAG_CONCURRENCY = max(env_int("TAG_CONCURRENCY", 3), 1)

LIB_DIR = os.path.join(DATA_DIR, "library")      # one JSON per channel (delete one to reset that channel)
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
PATHS_FILE = os.path.join(DATA_DIR, "paths.json")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

AUDIO_EXT = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".aiff", ".wma"}
PLAYABLE_RE = re.compile(r"\.(mp3|flac|m4a|aac|wav|ogg|opus)$", re.I)   # same list as AUDIO_RE in Uzikext
MIME_EXT = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/flac": ".flac", "audio/x-flac": ".flac",
            "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a", "audio/aac": ".aac",
            "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/wav": ".wav", "audio/x-wav": ".wav",
            "audio/vnd.wave": ".wav"}
MIN_KBPS, KBPS_TOLERANCE = 320, 0.94             # only used by the admin page's "Hide MP3 < 320 kbps" box
CHUNK = 128 * 1024                               # divides 1 MB, so Telegram requests never cross a 1 MB boundary
PIECE = 512 * 1024                               # what a track is fetched in: the largest request Telegram allows
STREAM_AHEAD = max(env_int("STREAM_AHEAD", 3), 1)        # pieces fetched at once for a track: fast, not greedy
PIECE_CACHE_MB = max(env_int("PIECE_CACHE_MB", 64), 8)   # the pieces kept in memory (never on disk)
WHILE_PLAYING = "pause" if os.environ.get("WHILE_PLAYING", "").strip().lower() == "pause" else "slow"
CRYPTO = "cryptg" if _tl_aes.cryptg else "openssl" if _tl_aes.libssl.decrypt_ige else "python"

os.makedirs(LIB_DIR, exist_ok=True)
client = TelegramClient(os.path.join(DATA_DIR, "session"), API_ID, API_HASH)
login_state = {}
libs, jobs, tasks = {}, {}, set()
sched = {"running": False, "current": None, "last_run": None, "next_run": None}
msg_cache = {}   # (channel, msg_id) -> (time, message): seeking doesn't cost two API calls every time
pieces = OrderedDict()        # (channel, msg_id, piece index) -> bytes: what's been fetched lately (memory only)
pieces_bytes = [0]
inflight = {}                 # (channel, msg_id, piece index) -> Future: a piece being fetched (shared, not fetched twice)
dl_log = []                   # (start, end, bytes) of recent fetches: the download speed
playing = {"n": 0, "last": 0.0}   # tracks being streamed now / when the last piece went out


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def start_task(coro):
    t = asyncio.create_task(coro)
    tasks.add(t)
    t.add_done_callback(tasks.discard)
    return t


# ---------- files on /data ----------
def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def load_settings():
    s = read_json(SETTINGS_FILE, {})
    s.setdefault("channels", {})
    return s


def selected():
    """Ticked channels: {channel_id: {"title":…, "username":…}}"""
    return {int(k): v for k, v in load_settings()["channels"].items()}


def update_channel_info(channel, title, username):
    s = load_settings()
    info = s["channels"].get(str(channel))
    if info is not None and (info.get("title") != title or info.get("username") != username):
        info.update(title=title, username=username)
        write_json(SETTINGS_FILE, s)
        manifest_changed()


def lib_path(ch):
    return os.path.join(LIB_DIR, f"{ch}.json")


def load_lib(ch):
    if ch not in libs:
        lib = read_json(lib_path(ch), None)
        if lib is None:
            return None
        libs[ch] = lib
    return libs[ch]


def save_lib(ch, lib):
    write_json(lib_path(ch), lib)
    manifest_changed()


# ---------- manifest cache ----------
# Building the track list for Uzikext goes through every track of every ticked channel (hundreds of
# thousands), so it's built once per change, in a thread (the server keeps streaming meanwhile), and the
# result (JSON, gzipped JSON, ETag) is kept until something changes again.
_manifest_lock = threading.Lock()
_manifest_version = 0
_manifest_cache = {}            # format ("v1" / "v2") -> (version, body, gzipped body, etag)
_paths = None                   # uid -> [current path, former paths…], loaded once


def manifest_changed():
    global _manifest_version
    _manifest_version += 1


def _paths_history():
    global _paths
    if _paths is None:
        _paths = read_json(PATHS_FILE, {})
    return _paths


def _manifest_bytes(fmt):
    with _manifest_lock:                      # one build at a time; others wait and reuse the result
        version = _manifest_version
        hit = _manifest_cache.get(fmt)
        if hit and hit[0] == version:
            return hit
        data = build_manifest_v2() if fmt == "v2" else build_manifest()
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        entry = (version, body, gzip.compress(body, 6), '"' + hashlib.sha1(body).hexdigest() + '"')
        _manifest_cache[fmt] = entry
        return entry


# ---------- Telegram helpers ----------
async def get_entity(channel):
    try:
        return await client.get_entity(channel)
    except ValueError:
        await client.get_dialogs()           # refills the session's entity cache (e.g. after a restore)
        return await client.get_entity(channel)


async def get_message(channel, msg_id, fresh=False):
    key = (channel, msg_id)
    hit = msg_cache.get(key)
    if hit and not fresh and time.time() - hit[0] < 1800:
        return hit[1]
    m = await client.get_messages(await get_entity(channel), ids=msg_id)
    if len(msg_cache) > 500:
        msg_cache.clear()
    msg_cache[key] = (time.time(), m)
    return m


def safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip() or "file"


def is_audio(m) -> bool:
    if not m.file:
        return False
    if m.audio:
        return True
    mime = (m.file.mime_type or "").lower()
    ext = (m.file.ext or "").lower()
    return mime.startswith("audio/") or ext in AUDIO_EXT


def build_tracks(msgs):
    # Telegram has no album field: the caption of a media group is the fallback album name
    group_album = {}
    for m in msgs:
        cap = (m.message or "").strip()
        if m.grouped_id and cap and m.grouped_id not in group_album:
            group_album[m.grouped_id] = cap.splitlines()[0]

    tracks = []
    for m in msgs:
        cap = (m.message or "").strip()
        if m.grouped_id:
            album = group_album.get(m.grouped_id) or f"Untitled album ({m.date:%Y-%m-%d})"
            gid = str(m.grouped_id)
        else:
            album = cap.splitlines()[0] if cap else "Singles"
            gid = f"single-{m.id}" if cap else "single-none"
        tracks.append({
            "id": m.id, "gid": gid, "album": album,
            "name": m.file.name or f"{m.id}{m.file.ext or ''}",
            "title": m.file.title or "",
            "performer": m.file.performer or "",
            "size": m.file.size or 0,
            "duration": m.file.duration or 0,
            "mime": m.file.mime_type or "",
            "date": m.date.isoformat(),
            "mp3": (m.file.ext or "").lower() == ".mp3" or (m.file.mime_type or "") == "audio/mpeg",
            "kbps": round((m.file.size or 0) * 8 / m.file.duration / 1000) if m.file.duration else None,
        })
    return tracks


# ---------- album tags read straight from the audio files ----------


class Remote:
    """Random access to a Telegram file; fetches only the 128 KB chunks that are needed."""

    def __init__(self, media, size):
        self.media, self.size, self.chunks = media, size, {}

    async def chunk(self, idx):
        if idx not in self.chunks:
            data = b""
            async for c in client.iter_download(self.media, offset=idx * CHUNK, request_size=CHUNK):
                data = bytes(c)
                break
            self.chunks[idx] = data
        return self.chunks[idx]

    async def read(self, off, n):
        n = min(n, self.size - off)
        out = bytearray()
        while len(out) < n:
            idx, rel = divmod(off + len(out), CHUNK)
            c = await self.chunk(idx)
            if not c:
                break
            out += c[rel: rel + n - len(out)]
        return bytes(out)


def syncsafe(b):
    return (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]


def id3_text(b):
    if not b:
        return ""
    codec = {0: "latin-1", 1: "utf-16", 2: "utf-16-be", 3: "utf-8"}.get(b[0], "latin-1")
    return b[1:].decode(codec, errors="ignore").strip("\x00 \ufeff").split("\x00")[0].strip()


# ---------- reading title / artist / album / album artist / genre / year / label from the files ----------
TAGS_V = 2   # version of what read_fields() collects; tracks read by an older version are re-read once
ID3_GENRES = [
    "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal",
    "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial",
    "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal",
    "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip",
    "Gospel", "Noise", "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
    "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk",
    "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40", "Christian Rap", "Pop/Funk",
    "Jungle", "Native American", "Cabaret", "New Wave", "Psychadelic", "Rave", "Showtunes", "Trailer", "Lo-Fi",
    "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock", "Folk",
    "Folk-Rock", "National Folk", "Swing", "Fast Fusion", "Bebob", "Latin", "Revival", "Celtic", "Bluegrass",
    "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock",
    "Big Band", "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech", "Chanson", "Opera",
    "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam",
    "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle", "Duet",
    "Punk Rock", "Drum Solo", "A capella", "Euro-House", "Dance Hall",
]
ID3_FRAMES = {
    2: {b"TT2": "title", b"TP1": "artist", b"TAL": "album", b"TP2": "albumArtist", b"TCO": "genre",
        b"TYE": "year", b"TPB": "label"},
    3: {b"TIT2": "title", b"TPE1": "artist", b"TALB": "album", b"TPE2": "albumArtist", b"TCON": "genre",
        b"TYER": "year", b"TDRC": "year", b"TPUB": "label"},
}
ID3_FRAMES[4] = ID3_FRAMES[3]
VORBIS_KEYS = {"TITLE": "title", "ARTIST": "artist", "ALBUM": "album", "ALBUMARTIST": "albumArtist",
               "ALBUM ARTIST": "albumArtist", "GENRE": "genre", "DATE": "year", "YEAR": "year",
               "LABEL": "label", "ORGANIZATION": "label", "PUBLISHER": "label"}
MP4_ITEMS = {b"\xa9nam": "title", b"\xa9ART": "artist", b"\xa9alb": "album", b"aART": "albumArtist",
             b"\xa9gen": "genre", b"\xa9day": "year", b"\xa9pub": "label"}


def genre_name(i):
    return ID3_GENRES[i] if 0 <= i < len(ID3_GENRES) else ""


def norm_genre(g):
    g = g.strip()
    m = re.fullmatch(r"\((\d+)\)(.*)", g)          # "(17)" or "(17)Rock"
    if m:
        return m.group(2).strip() or genre_name(int(m.group(1)))
    return genre_name(int(g)) if g.isdigit() else g


def clean_fields(f):
    out = {}
    for k, v in f.items():
        v = (v or "").strip()
        if k == "genre":
            v = norm_genre(v)
        elif k == "year":
            v = v[:10]                               # same as Uzikext: "2023" or "2023-05-01"
        if v:
            out[k] = v
    return out


async def id3v2_fields(r, head, out):
    ver, flags = head[3], head[5]
    if ver not in (2, 3, 4):
        return
    frames = ID3_FRAMES[ver]
    end = min(10 + syncsafe(head[6:10]), r.size)
    pos = 10
    if flags & 0x40 and ver in (3, 4):           # extended header
        ext = await r.read(pos, 4)
        pos += (int.from_bytes(ext, "big") + 4) if ver == 3 else syncsafe(ext)
    hlen, idlen = (6, 3) if ver == 2 else (10, 4)
    while pos + hlen <= end:
        h = await r.read(pos, hlen)
        if len(h) < hlen or h[0] == 0:           # padding
            break
        if ver == 2:
            size = int.from_bytes(h[3:6], "big")
        elif ver == 3:
            size = int.from_bytes(h[4:8], "big")
        else:
            size = syncsafe(h[4:8])
        if size <= 0 or pos + hlen + size > end:
            break
        key = frames.get(h[:idlen])
        if key and key not in out:
            out[key] = id3_text(await r.read(pos + hlen, min(size, 4096)))
        pos += hlen + size                       # big frames (cover art) are skipped, not downloaded


async def id3v1_fields(r, out):
    if r.size < 128:
        return
    tag = await r.read(r.size - 128, 128)
    if tag[:3] != b"TAG":
        return
    txt = lambda b: b.decode("latin-1").strip("\x00 ").strip()
    for key, val in (("title", txt(tag[3:33])), ("artist", txt(tag[33:63])), ("album", txt(tag[63:93])),
                     ("year", txt(tag[93:97])), ("genre", genre_name(tag[127]) if tag[127] != 255 else "")):
        if val and not out.get(key):
            out[key] = val


def vorbis_fields(data, out):
    if len(data) < 8:
        return
    p = 4 + int.from_bytes(data[:4], "little")
    n = int.from_bytes(data[p:p + 4], "little")
    p += 4
    for _ in range(min(n, 1000)):
        if p + 4 > len(data):
            break
        ln = int.from_bytes(data[p:p + 4], "little")
        p += 4
        if ln > len(data) - p:                   # truncated (e.g. huge embedded picture): stop here
            break
        k, _, v = data[p:p + ln].decode("utf-8", errors="ignore").partition("=")
        p += ln
        key = VORBIS_KEYS.get(k.upper())
        if key and v.strip() and key not in out:
            out[key] = v


async def flac_fields(r, out):
    pos = 4
    while pos + 4 <= r.size:
        h = await r.read(pos, 4)
        last, btype, length = h[0] >> 7, h[0] & 0x7F, int.from_bytes(h[1:4], "big")
        if btype == 4:                           # VORBIS_COMMENT
            vorbis_fields(await r.read(pos + 4, min(length, 1_000_000)), out)
            return
        pos += 4 + length                        # skips STREAMINFO / PICTURE etc.
        if last:
            return


def mp4_item(buf, name):
    i = buf.find(name)
    while i >= 4:
        if buf[i + 8:i + 12] == b"data":         # <size><name><size>"data"<flags><locale><payload>
            dsize = int.from_bytes(buf[i + 4:i + 8], "big")
            return buf[i + 20:i + 4 + dsize]
        i = buf.find(name, i + 1)
    return None


async def mp4_fields(r, out):
    pos = 0
    while pos + 8 <= r.size:
        h = await r.read(pos, 16)
        size, typ, hdr = int.from_bytes(h[:4], "big"), h[4:8], 8
        if size == 1:
            size, hdr = int.from_bytes(h[8:16], "big"), 16
        elif size == 0:
            size = r.size - pos
        if size < hdr:
            return
        if typ == b"moov":
            if size > 8_000_000:
                return
            moov = await r.read(pos, size)
            ilst = moov.find(b"ilst")
            if ilst < 0:
                return
            moov = moov[ilst:]
            for name, key in MP4_ITEMS.items():
                v = mp4_item(moov, name)
                if v and key not in out:
                    out[key] = v.decode("utf-8", errors="ignore").strip("\x00 ")
            if "genre" not in out:
                g = mp4_item(moov, b"gnre")              # numeric genre: ID3 index + 1
                if g and len(g) >= 2:
                    out["genre"] = genre_name(int.from_bytes(g[:2], "big") - 1)
            return
        pos += size


async def ogg_fields(r, out):
    data = await r.read(0, 2 * CHUNK)
    for marker in (b"\x03vorbis", b"OpusTags"):
        i = data.find(marker)
        if i >= 0:
            vorbis_fields(data[i + len(marker):], out)
            return


async def read_fields(r, is_mp3=False):
    """Text tags of one file: {title, artist, album, albumArtist, genre, year, label} (only those found)."""
    out = {}
    try:
        head = await r.read(0, 12)
        if head[:3] == b"ID3":
            await id3v2_fields(r, head, out)
        elif head[:4] == b"fLaC":
            await flac_fields(r, out)
        elif head[4:8] == b"ftyp":
            await mp4_fields(r, out)
        elif head[:4] == b"OggS":
            await ogg_fields(r, out)
        if (is_mp3 or head[:3] == b"ID3") and not all(out.get(k) for k in ("title", "artist", "album", "year", "genre")):
            await id3v1_fields(r, out)
    except Exception:
        pass
    return clean_fields(out)


PLACEHOLDER_ALBUM = re.compile(r"^(Singles|Untitled album \(.*\))$")


def track_fields(t):
    """The six fields Uzikext needs, from Telegram and/or the file's tags ("" when unknown)."""
    tg = t.get("tags") or {}
    album = tg.get("album") or (t.get("album") if not PLACEHOLDER_ALBUM.match(t.get("album") or "") else "")
    return {"title": tg.get("title") or t.get("title") or "", "artist": tg.get("artist") or t.get("performer") or "",
            "album": album or "", "year": tg.get("year", ""), "genre": tg.get("genre", ""),
            "length": t.get("duration") or 0}


def track_complete(t):
    """Title, artist, album, year, genre and length all known."""
    return all(track_fields(t).values())


def needs_read(t):
    # New tracks always (their album decides where they're listed); others only when something is missing
    # and the file hasn't been read by this version yet: a file is read at most once.
    return not t.get("tag_checked") or (t.get("tags_v") != TAGS_V and not track_complete(t))


async def read_tags(channel, entity, lib, job):
    todo = [t for t in lib["tracks"] if needs_read(t)]
    todo.sort(key=lambda t: bool(t.get("tag_checked")))   # new tracks first, then re-reads of older ones
    job.update(phase="tags", tag_done=0, tag_total=len(todo))
    byid = {t["id"]: t for t in todo}
    sem = asyncio.Semaphore(TAG_CONCURRENCY)

    def mark_read(t, fields):
        t["tags"] = fields
        t["tag_album"] = fields.get("album")
        t["tag_checked"] = True
        t["tags_v"] = TAGS_V

    async def one(m):
        t = byid[m.id]
        if not m.file:
            mark_read(t, {})
            return
        await sync_turn()
        async with sem:
            try:
                await sync_turn()
                mark_read(t, await read_fields(Remote(m.media, m.file.size), t.get("mp3", False)))
            except Exception:
                pass  # network hiccup: left as is, retried on the next refresh

    ids = list(byid)
    for i in range(0, len(ids), 50):
        batch = ids[i:i + 50]
        msgs = await client.get_messages(entity, ids=batch)
        found, coros = set(), []
        for m in msgs:
            if m:
                found.add(m.id)
                coros.append(one(m))
        for mid in batch:                         # message deleted: nothing to read
            if mid not in found:
                mark_read(byid[mid], {})
        await asyncio.gather(*coros)
        job["tag_done"] = min(i + 50, len(ids))
        save_lib(channel, lib)


async def backfill_meta(channel, entity, lib, job):
    """Libraries cached by older versions have no duration/mime: fill them in (100 messages per request)."""
    todo = [t for t in lib["tracks"] if "duration" not in t]
    if not todo:
        return
    job.update(phase="meta", tag_done=0, tag_total=len(todo))
    byid = {t["id"]: t for t in todo}
    ids = list(byid)
    for i in range(0, len(ids), 100):
        batch = ids[i:i + 100]
        for m in await client.get_messages(entity, ids=batch):
            if m and m.file:
                t = byid[m.id]
                t["duration"] = m.file.duration or 0
                t["mime"] = m.file.mime_type or ""
                if m.file.duration:
                    t["kbps"] = round((m.file.size or 0) * 8 / m.file.duration / 1000)
        for mid in batch:
            byid[mid].setdefault("duration", 0)
        job["tag_done"] = min(i + 100, len(ids))
    save_lib(channel, lib)


def new_job():
    return {"running": True, "phase": "list", "found": 0, "oldest": None, "added": 0,
            "tag_done": 0, "tag_total": 0, "error": None, "started": now_iso()}


async def scan_job(channel: int, full: bool):
    job = jobs[channel]
    try:
        entity = await get_entity(channel)
        prev = load_lib(channel)
        prev_read = {t["id"]: t for t in prev["tracks"] if t.get("tag_checked")} if prev else {}
        lib = None if full else prev
        min_id = lib["last_id"] if lib else 0   # incremental: only messages newer than the last scan
        cutoff = None
        if not lib and SCAN_YEARS:
            cutoff = datetime.now(timezone.utc) - timedelta(days=365 * SCAN_YEARS)

        seen, msgs = set(), []
        for flt in (InputMessagesFilterMusic, InputMessagesFilterDocument):
            async for m in client.iter_messages(entity, filter=flt, min_id=min_id):
                if cutoff and m.date < cutoff:
                    break
                job["oldest"] = m.date.strftime("%Y-%m-%d")
                if m.id not in seen and is_audio(m):
                    seen.add(m.id)
                    msgs.append(m)
                    job["found"] = len(msgs)

        old = lib["tracks"] if lib else []
        known = {t["id"] for t in old}
        added = [t for t in build_tracks(msgs) if t["id"] not in known]
        tracks = old + added
        for t in tracks:
            p = prev_read.get(t["id"])
            if p and not t.get("tag_checked"):
                for k in ("tag_album", "tag_checked", "tags", "tags_v"):
                    if k in p:
                        t[k] = p[k]
        title = getattr(entity, "title", None) or str(channel)
        username = getattr(entity, "username", None)
        new_lib = {
            "title": title, "username": username,
            "last_id": max((t["id"] for t in tracks), default=0),
            "updated": now_iso(),
            "years": lib.get("years") if lib else (SCAN_YEARS or None),
            "tracks": tracks,
        }
        libs[channel] = new_lib
        save_lib(channel, new_lib)
        update_channel_info(channel, title, username)
        job["added"] = len(added)
        await backfill_meta(channel, entity, new_lib, job)
        await read_tags(channel, entity, new_lib, job)
        start_task(asyncio.to_thread(_manifest_bytes, "v2"))   # have the new list ready before it's asked for
    except Exception as e:
        job["error"] = str(e)
        print(f"[scan {channel}] {e!r}", flush=True)
    finally:
        job["running"] = False
        job["finished"] = now_iso()


async def run_scan(channel, full=False):
    if jobs.get(channel, {}).get("running"):
        return
    jobs[channel] = new_job()
    await scan_job(channel, full)


async def refresh_all():
    if sched["running"] or not await client.is_user_authorized():
        return
    sched["running"] = True
    try:
        for ch in selected():
            sched["current"] = ch
            await run_scan(ch)
        sched["last_run"] = now_iso()
    finally:
        sched["running"], sched["current"] = False, None


async def scheduler():
    await asyncio.sleep(15)
    while True:
        try:
            await refresh_all()
        except Exception as e:
            print(f"[refresh] {e!r}", flush=True)
        sched["next_run"] = (datetime.now() + timedelta(minutes=REFRESH_MINUTES)).isoformat(timespec="seconds")
        await asyncio.sleep(REFRESH_MINUTES * 60)


# ---------- manifest for Uzikext ----------
def seg(s, fallback="_"):
    """One path segment that is also a valid Windows file/folder name."""
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", s or "").strip().rstrip(". ")
    return s[:120] or fallback


def playable_name(t):
    name = seg(t["name"], str(t["id"]))
    if PLAYABLE_RE.search(name):
        return name
    if os.path.splitext(name)[1].lower() in (".aiff", ".aif", ".wma"):
        return None                                   # browsers can't play these
    ext = MIME_EXT.get((t.get("mime") or "").lower()) or (".mp3" if t.get("mp3") else None)
    return name + ext if ext else None


def album_map(lib):
    """track id -> album name, with the same grouping the admin page shows."""
    groups = {}
    for t in lib["tracks"]:
        groups.setdefault(group_key(t), []).append(t)
    out = {}
    for ts in groups.values():
        tags = Counter(x["tag_album"] for x in ts if x.get("tag_album"))
        album = tags.most_common(1)[0][0] if tags else ts[0]["album"]
        for x in ts:
            out[x["id"]] = album
    return out


def tg_link(channel, username, msg_id):
    if username:
        return f"https://t.me/{username}/{msg_id}"
    s = str(channel)
    return f"https://t.me/c/{s[4:]}/{msg_id}" if s.startswith("-100") else None


def manifest_records():
    """Yields ('channel', info) and ('track', record) for every listed track of every ticked channel."""
    paths = _paths_history()
    changed, used_folders = False, set()
    for ch, info in sorted(selected().items(), key=lambda kv: (kv[1].get("title") or "").lower()):
        lib = load_lib(ch)
        if not lib:
            continue
        title = lib.get("title") or info.get("title") or str(ch)
        username = lib.get("username", info.get("username"))
        folder = seg(title)
        if folder.lower() in used_folders:
            folder = f"{folder} ({ch})"
        used_folders.add(folder.lower())
        tracks = list(lib["tracks"])          # a snapshot: scans may append meanwhile
        albums, taken, count = album_map({"tracks": tracks}), set(), 0
        chan = {"id": ch, "title": title, "folder": folder, "username": username, "updated": lib.get("updated")}
        yield "channel", chan
        for t in sorted(tracks, key=lambda x: x["id"]):
            if not t.get("tag_checked"):
                continue          # listed once its file is read, so its path doesn't move right after
            name = playable_name(t)
            if not name:
                continue
            album = albums.get(t["id"]) or "Singles"
            afold = seg(album)
            rel = f"{folder}/{afold}/{name}"
            if rel.lower() in taken:                  # same file name twice in one album: oldest keeps it
                stem, ext = os.path.splitext(name)
                name = f"{stem} ({t['id']}){ext}"
                rel = f"{folder}/{afold}/{name}"
            taken.add(rel.lower())
            uid = f"{ch}:{t['id']}"
            hist = paths.get(uid)
            if not hist:
                paths[uid] = hist = [rel]
                changed = True
            elif hist[0] != rel:
                paths[uid] = hist = [rel] + [p for p in hist if p != rel][:9]
                changed = True
            tags = t.get("tags") or {}
            yield "track", {
                "ch": ch, "id": t["id"], "uid": uid, "path": rel, "afold": afold, "name": name, "former": hist[1:],
                "title": tags.get("title") or t.get("title") or os.path.splitext(name)[0],
                "artist": tags.get("artist") or t.get("performer") or "",
                "album": album, "albumArtist": tags.get("albumArtist", ""), "genre": tags.get("genre", ""),
                "year": tags.get("year", ""), "label": tags.get("label", ""),
                # true when the metadata won't change any more: complete, or the file has been read (an empty
                # field then means the file doesn't have it). Uzikext never reads Telegram files itself.
                "final": t.get("tags_v") == TAGS_V or track_complete(t),
                "duration": t.get("duration") or 0, "size": t.get("size") or 0, "kbps": t.get("kbps"),
                "date": t["date"], "channel": title, "username": username,
            }
            count += 1
        chan["tracks"] = count
    if changed:
        write_json(PATHS_FILE, paths)


def build_manifest():
    """Version 1: one object per track (kept for older Uzikext versions)."""
    channels, out = [], []
    for kind, r in manifest_records():
        if kind == "channel":
            channels.append(r)
            continue
        out.append({"uid": r["uid"], "path": r["path"], "formerPaths": r["former"], "name": r["name"],
                    "stream": f"/stream/{r['ch']}/{r['id']}", "title": r["title"], "artist": r["artist"],
                    "album": r["album"], "albumArtist": r["albumArtist"], "genre": r["genre"], "year": r["year"],
                    "label": r["label"], "metaFinal": r["final"], "duration": r["duration"], "size": r["size"],
                    "kbps": r["kbps"], "date": r["date"], "channel": r["channel"], "channelId": r["ch"],
                    "tg": tg_link(r["ch"], r["username"], r["id"])})
    return {"version": 1, "channels": channels, "tracks": out}


def build_manifest_v2():
    """Version 2, compact: one array per field, and the repetitive texts (albums, artists, genres…) stored
    once in a string table and referred to by number. Uzikext rebuilds paths, stream URLs, uids and
    Telegram links from the channel and message id."""
    strings, index = [], {}

    def sid(v):
        v = v or ""
        i = index.get(v)
        if i is None:
            i = index[v] = len(strings)
            strings.append(v)
        return i

    sid("")                                   # 0 = empty
    channels, chan_index = [], {}
    cols = {k: [] for k in ("ch", "id", "afold", "name", "title", "artist", "album", "albumArtist", "genre",
                            "year", "label", "dur", "size", "kbps", "date", "final")}
    former = {}
    for kind, r in manifest_records():
        if kind == "channel":
            chan_index[r["id"]] = len(channels)
            channels.append(r)
            continue
        i = len(cols["id"])
        cols["ch"].append(chan_index[r["ch"]]); cols["id"].append(r["id"])
        cols["afold"].append(sid(r["afold"])); cols["name"].append(r["name"]); cols["title"].append(r["title"])
        cols["artist"].append(sid(r["artist"])); cols["album"].append(sid(r["album"]))
        cols["albumArtist"].append(sid(r["albumArtist"])); cols["genre"].append(sid(r["genre"]))
        cols["year"].append(sid(r["year"])); cols["label"].append(sid(r["label"]))
        cols["dur"].append(r["duration"]); cols["size"].append(r["size"]); cols["kbps"].append(r["kbps"] or 0)
        try:
            cols["date"].append(int(datetime.fromisoformat(r["date"]).timestamp()))
        except Exception:
            cols["date"].append(0)
        cols["final"].append(1 if r["final"] else 0)
        if r["former"]:
            former[i] = r["former"]
    return {"version": 2, "channels": channels, "strings": strings, "tracks": cols, "former": former}


# ---------- app ----------
@asynccontextmanager
async def lifespan(_app):
    if not API_ID or not API_HASH:
        raise RuntimeError("TG_API_ID and TG_API_HASH must be set (get them at https://my.telegram.org)")
    print(f"decryption: {CRYPTO}" + ("" if CRYPTO != "python" else " (slow: install cryptg)") +
          f" · {STREAM_AHEAD} pieces of 512 KB at once · while a track plays, the sync {'pauses' if WHILE_PLAYING == 'pause' else 'slows down'}", flush=True)
    await client.connect()
    start_task(scheduler())
    yield
    for t in list(tasks):
        t.cancel()
    await client.disconnect()


app = FastAPI(lifespan=lifespan)
CORS = {"Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, If-None-Match",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, ETag"}
PUBLIC = {"/", "/health"}


@app.middleware("http")
async def auth(request: Request, call_next):
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=CORS)
    if TOKEN and request.url.path not in PUBLIC:
        h = request.headers.get("authorization", "")
        tok = h[7:].strip() if h.lower().startswith("bearer ") else request.query_params.get("token", "")
        if not hmac.compare_digest(tok.encode(), TOKEN.encode()):
            return JSONResponse({"error": "unauthorized"}, status_code=401, headers=CORS)
    resp = await call_next(request)
    for k, v in CORS.items():
        resp.headers[k] = v
    return resp


class Login(BaseModel):
    phone: str
    code: str | None = None
    password: str | None = None


class Select(BaseModel):
    id: int
    selected: bool
    title: str = ""
    username: str | None = None


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/health")
async def health():
    return {"ok": True, "authorized": await client.is_user_authorized(), "channels": len(selected()),
            "lastRefresh": sched["last_run"], "nextRefresh": sched["next_run"]}


def transfer_info():
    return {"crypto": CRYPTO, "downloadSpeed": download_speed(), "whilePlaying": WHILE_PLAYING,
            "streamAhead": STREAM_AHEAD, "playing": playback_active(), "tagConcurrency": TAG_CONCURRENCY}


@app.get("/api/status")
async def status():
    authorized = await client.is_user_authorized()
    me = None
    if authorized:
        u = await client.get_me()
        me = " ".join(x for x in (u.first_name, u.last_name) if x) or u.username
    return {"authorized": authorized, "me": me, "refreshMinutes": REFRESH_MINUTES,
            "scanYears": SCAN_YEARS or None, "sched": sched, **transfer_info()}


@app.post("/api/send_code")
async def send_code(b: Login):
    r = await client.send_code_request(b.phone)
    login_state["hash"] = r.phone_code_hash
    return {"ok": True}


@app.post("/api/sign_in")
async def sign_in(b: Login):
    try:
        await client.sign_in(b.phone, b.code, phone_code_hash=login_state.get("hash"))
    except SessionPasswordNeededError:
        if not b.password:
            return {"need_password": True}
        await client.sign_in(password=b.password)
    start_task(refresh_all())
    return {"ok": True}


@app.post("/api/logout")
async def logout():
    """Signs the bridge out of Telegram (Uzikext → Library → Telegram → Sign out). The channels' cached lists
    stay; signing in again (with any account) picks them up."""
    try:
        await client.log_out()
    except Exception:
        pass
    me_name.pop("v", None)
    # a new client for the next sign-in (log_out disconnects this one)
    try:
        await client.connect()
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/channels")
async def channels():
    """Every channel/group of the account, with whether it's ticked and its cache state."""
    sel = selected()
    out = []
    async for d in client.iter_dialogs():
        if not (d.is_channel or d.is_group):
            continue
        lib = load_lib(d.id) if d.id in sel else None
        out.append({"id": d.id, "title": d.title, "username": getattr(d.entity, "username", None),
                    "selected": d.id in sel,
                    "tracks": len(lib["tracks"]) if lib else 0,
                    "updated": lib.get("updated") if lib else None})
    out.sort(key=lambda c: (not c["selected"], c["title"].lower()))
    return out


@app.post("/api/channels/select")
async def select_channel(b: Select):
    s = load_settings()
    if b.selected:
        s["channels"][str(b.id)] = {"title": b.title, "username": b.username}
        write_json(SETTINGS_FILE, s)
        manifest_changed()
        lib = load_lib(b.id)
        if not lib or any(needs_read(t) for t in lib["tracks"]):
            start_task(run_scan(b.id))
    else:
        s["channels"].pop(str(b.id), None)
        write_json(SETTINGS_FILE, s)
        manifest_changed()
    return {"ok": True}


@app.get("/api/jobs")
async def jobs_status():
    """Cheap status for polling: scheduler + per-channel scan progress and cache size."""
    out = {}
    for ch in selected():
        lib = load_lib(ch)
        out[str(ch)] = {"job": jobs.get(ch), "tracks": len(lib["tracks"]) if lib else 0,
                        "updated": lib.get("updated") if lib else None,
                        "title": (lib or {}).get("title") or selected()[ch].get("title") or str(ch)}
    return {"sched": sched, "channels": out}


me_name = {}


@app.get("/api/stats")
async def stats():
    """Summary for Uzikext's "Telegram bridge" view: refresh schedule, and per channel how many tracks
    there are, how many files have been read, how many are complete and which fields are missing."""
    authorized = await client.is_user_authorized()
    if authorized and "v" not in me_name:
        u = await client.get_me()
        me_name["v"] = " ".join(x for x in (u.first_name, u.last_name) if x) or u.username
    out = []
    for ch, info in selected().items():
        lib = load_lib(ch)
        tracks = lib["tracks"] if lib else []
        listed = read = complete = 0
        missing = Counter()
        for t in tracks:
            if t.get("tag_checked") and playable_name(t):
                listed += 1
            fields = track_fields(t)
            final = t.get("tags_v") == TAGS_V or all(fields.values())
            if final:
                read += 1
                for k, v in fields.items():
                    if not v:
                        missing[k] += 1          # read, and the file doesn't have it
            if all(fields.values()):
                complete += 1
        job = jobs.get(ch)
        out.append({"id": ch, "title": (lib or {}).get("title") or info.get("title") or str(ch),
                    "tracks": len(tracks), "listed": listed, "read": read, "waiting": len(tracks) - read,
                    "complete": complete, "missing": dict(missing),
                    "updated": (lib or {}).get("updated"), "years": (lib or {}).get("years"), "job": job})
    out.sort(key=lambda c: c["title"].lower())
    return {"authorized": authorized, "me": me_name.get("v"), "refreshMinutes": REFRESH_MINUTES,
            "scanYears": SCAN_YEARS or None, "sched": sched, "channels": out, **transfer_info()}


@app.post("/api/refresh_all")
async def refresh_all_now():
    if sched["running"]:
        return {"started": False}
    start_task(refresh_all())
    return {"started": True}


@app.post("/api/scan/{channel}")
async def start_scan(channel: int, full: bool = False):
    if jobs.get(channel, {}).get("running"):
        return {"started": False}
    start_task(run_scan(channel, full))
    return {"started": True}


@app.get("/api/manifest")
async def manifest(request: Request, v: int = 1):
    """The track list for Uzikext. ?v=2 is the compact format. Cached until the library changes, sent
    gzipped when the client accepts it, and answered with 304 when the client already has this version."""
    _, body, body_gz, etag = await asyncio.to_thread(_manifest_bytes, "v2" if v == 2 else "v1")
    headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if "gzip" in request.headers.get("accept-encoding", ""):
        headers["Content-Encoding"] = "gzip"
        return Response(body_gz, media_type="application/json", headers=headers)
    return Response(body, media_type="application/json", headers=headers)


# ---------- admin page: browse / search ----------
def low_quality(t: dict) -> bool:
    # Only MP3s with a known (estimated) bitrate below the threshold are rejected
    return bool(t.get("mp3")) and t.get("kbps") is not None and t["kbps"] < MIN_KBPS * KBPS_TOLERANCE


def matches(t: dict, terms: list[str], field: str) -> bool:
    fields = {
        "track": [t["title"], t["name"]],
        "album": [t["album"], t.get("tag_album") or ""],
        "artist": [t["performer"]],
        "all": [t["title"], t["name"], t["album"], t.get("tag_album") or "", t["performer"]],
    }[field]
    hay = " ".join(fields).lower()
    return all(term in hay for term in terms)



def group_key(t):
    ta = t.get("tag_album")
    if ta and t["gid"].startswith("single"):     # loose tracks with the same album tag + artist are grouped
        return "tag:" + ta.lower() + "|" + t["performer"].lower()
    return t["gid"]


def query_lib(lib, q, field, hq):
    if field not in ("all", "track", "album", "artist"):
        field = "all"
    terms = q.lower().split()

    groups = {}
    for t in lib["tracks"]:
        if hq and low_quality(t):
            continue
        key = group_key(t)
        g = groups.setdefault(key, {"gid": key, "album": t["album"], "tracks": [], "any": False})
        hit = matches(t, terms, field) if terms else True
        g["tracks"].append({**t, "match": hit})
        g["any"] = g["any"] or hit

    out = []
    for g in groups.values():
        if not g["any"]:
            continue
        g["tracks"].sort(key=lambda x: x["id"])
        tags = Counter(x["tag_album"] for x in g["tracks"] if x.get("tag_album"))
        if tags:
            g["album"] = tags.most_common(1)[0][0]
        g["size"] = sum(x["size"] for x in g["tracks"])
        g["date"] = max(x["date"] for x in g["tracks"])
        g["artists"] = sorted({x["performer"] for x in g["tracks"] if x["performer"]})
        del g["any"]
        out.append(g)
    out.sort(key=lambda g: g["date"], reverse=True)
    return out


@app.get("/api/library/{channel}")
async def library(channel: int, q: str = "", field: str = "all", hq: bool = False):
    lib = load_lib(channel)
    if not lib:
        return {"total": 0, "updated": None, "groups": []}
    groups = query_lib(lib, q, field, hq)
    for g in groups:
        g["channel"] = channel
    return {"total": len(lib["tracks"]), "updated": lib.get("updated"), "groups": groups}


@app.get("/api/search_all")
async def search_all(q: str = "", field: str = "all", hq: bool = False):
    out, total = [], 0
    for ch in selected():
        lib = load_lib(ch)
        if not lib:
            continue
        total += len(lib["tracks"])
        for g in query_lib(lib, q, field, hq):
            g["channel"] = ch
            out.append(g)
    out.sort(key=lambda g: g["date"], reverse=True)
    return {"total": total, "groups": out}


# ---------- audio ----------
# A track is fetched from Telegram in 512 KB pieces, a few at once (STREAM_AHEAD), in order. A piece is fetched
# once: a second request for it (the player and the waveform, a seek, the next track fetched ahead) waits for
# the same fetch. The latest pieces stay in memory (PIECE_CACHE_MB), never on disk.
async def fetch_piece(m, idx):
    for attempt in range(4):
        try:
            async for c in client.iter_download(m.media, offset=idx * PIECE, request_size=PIECE):
                return bytes(c)
            return b""
        except FloodWaitError as e:              # Telegram asks to wait: wait (no hammering)
            await asyncio.sleep(min(e.seconds, 30) + 1)
        except (ConnectionError, asyncio.TimeoutError, OSError):
            await asyncio.sleep(0.5 * (attempt + 1))
    raise HTTPException(503, "Telegram didn't send this part of the track")


def note_speed(t0, t1, n):
    dl_log.append((t0, t1, n))
    while len(dl_log) > 60 or (dl_log and t1 - dl_log[0][1] > 30):
        dl_log.pop(0)


def download_speed():
    """Bytes per second over the recent fetches (they overlap: bytes over the time they spanned), or None."""
    if not dl_log:
        return None
    span = max(e[1] for e in dl_log) - min(e[0] for e in dl_log)
    total = sum(e[2] for e in dl_log)
    return round(total / span) if span > 0.05 and total >= PIECE else None


async def piece(channel, msg_id, m, idx):
    key = (channel, msg_id, idx)
    if key in pieces:
        pieces.move_to_end(key)
        return pieces[key]
    if key in inflight:
        return await asyncio.shield(inflight[key])
    fut = asyncio.get_running_loop().create_future()
    inflight[key] = fut
    try:
        t0 = time.monotonic()
        data = await fetch_piece(m, idx)
        note_speed(t0, time.monotonic(), len(data))
        pieces[key] = data
        pieces_bytes[0] += len(data)
        while pieces_bytes[0] > PIECE_CACHE_MB * 1048576 and len(pieces) > 1:
            pieces_bytes[0] -= len(pieces.popitem(last=False)[1])
        fut.set_result(data)
        return data
    except BaseException as e:
        if not fut.done():
            fut.set_exception(e if isinstance(e, Exception) else RuntimeError("cancelled"))
            fut.exception()                       # (read: no "never retrieved" warning)
        raise
    finally:
        inflight.pop(key, None)


async def pieces_from(channel, msg_id, m, first, last):
    """Pieces first..last in order, STREAM_AHEAD of them being fetched at any time."""
    ahead = {}
    nxt = first
    try:
        for idx in range(first, last + 1):
            while nxt <= last and nxt < idx + STREAM_AHEAD:
                ahead[nxt] = asyncio.ensure_future(piece(channel, msg_id, m, nxt))
                nxt += 1
            yield await ahead.pop(idx)
    finally:
        for t in ahead.values():
            t.cancel()


def playback_active():
    return playing["n"] > 0 or time.monotonic() - playing["last"] < 8


slow_turn = asyncio.Lock()


async def sync_turn():
    """Before each file the sync reads: while a track plays, the sync pauses (WHILE_PLAYING=pause) or slows
    down (one file at a time, a second apart): the track comes first."""
    while WHILE_PLAYING == "pause" and playback_active():
        await asyncio.sleep(1)
    if playback_active():
        async with slow_turn:
            await asyncio.sleep(1)


@app.api_route("/stream/{channel}/{msg_id}", methods=["GET", "HEAD"])
async def stream(channel: int, msg_id: int, request: Request, dl: bool = False):
    """Streams one track with HTTP Range support (seeking). ?dl=1 makes the browser save it."""
    m = await get_message(channel, msg_id)
    if not m or not m.file:
        raise HTTPException(404)
    size = m.file.size
    start, end, status = 0, size - 1, 200

    mt = re.match(r"bytes=(\d*)-(\d*)", request.headers.get("range", ""))
    if mt:
        g1, g2 = mt.groups()
        if g1 == "" and g2:
            start, end = max(size - int(g2), 0), size - 1
        else:
            start = int(g1) if g1 else 0
            end = min(int(g2), size - 1) if g2 else size - 1
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        status = 206

    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1)}
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if dl:
        name = m.file.name or f"{m.id}{m.file.ext or ''}"
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(name)}"
    media_type = m.file.mime_type or "audio/mpeg"
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers, media_type=media_type)

    async def gen():
        playing["n"] += 1
        try:
            first, last = start // PIECE, end // PIECE
            pos = first * PIECE
            async for data in pieces_from(channel, msg_id, m, first, last):
                playing["last"] = time.monotonic()
                lo, hi = max(start, pos), min(end + 1, pos + len(data))
                if hi > lo:
                    yield data[lo - pos: hi - pos]
                if not data:
                    break
                pos += len(data)
        except Exception:
            msg_cache.pop((channel, msg_id), None)   # e.g. expired file reference: refetch next time
            raise
        finally:
            playing["n"] -= 1
            playing["last"] = time.monotonic()

    return StreamingResponse(gen(), status_code=status, headers=headers, media_type=media_type)


@app.post("/api/prefetch/{channel}/{msg_id}")
async def prefetch(channel: int, msg_id: int, size: int = 2 * 1048576):
    """The start of a track (`size` bytes, 2 MB by default: about a minute of MP3) fetched into memory now, so
    it starts at once when it's played. Nothing is kept on disk."""
    m = await get_message(channel, msg_id)
    if not m or not m.file:
        raise HTTPException(404)
    last = min(max(size, 1), m.file.size) // PIECE

    async def run():
        playing["last"] = time.monotonic()
        async for _ in pieces_from(channel, msg_id, m, 0, last):
            pass
    start_task(run())
    return {"ok": True, "pieces": last + 1}


@app.get("/api/zip/{channel}")
async def zip_album(channel: int, ids: str, name: str = "album"):
    entity = await get_entity(channel)
    id_list = [int(i) for i in ids.split(",") if i.strip()]
    msgs = await client.get_messages(entity, ids=id_list)

    tmp = tempfile.mkdtemp()
    zpath = os.path.join(tmp, "album.zip")
    try:
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_STORED) as z:
            for i, m in enumerate(msgs, 1):
                if not m or not m.file:
                    continue
                fname = safe(m.file.name or f"{m.id}{m.file.ext or ''}")
                arc = f"{i:02d} - {fname}"
                p = await client.download_media(m, file=os.path.join(tmp, arc))
                z.write(p, arcname=arc)
                os.remove(p)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return FileResponse(zpath, media_type="application/zip", filename=f"{safe(name)}.zip",
                        background=BackgroundTask(shutil.rmtree, tmp, True))

