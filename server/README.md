# Uzikext server v4

**v4 (phase 1 of the easy setup):**

- **Pairing instead of a token.** Each device pairs with a 6-digit code and gets a key of its own; devices are
  listed and removed in Uzikext's settings (⋮ → Sync → Devices). `SYNC_TOKEN` is optional: while it's set, devices
  using it keep working and get their own key by themselves; switch it off in ⋮ → Sync → Devices once they all have.
- **Found by itself.** Uzikext → Sync → *Find my server* finds it on the home network, and follows it to a
  new address (it's known by its identity, not its address).
- **Set from Uzikext.** Its name, the music folder (found by itself: no more `MUSIC_ROOT_NAME`), the analysis
  speed, the backups (hourly/daily, the copy folder) are in Uzikext's settings (⋮ → Analysis, ⋮ → Backups); the environment variables only
  give the starting values.
- **Telegram inside the server.** The Telegram bridge runs in the same container (started and watched by the
  server, its data in `data/telegram`). Each user enters their own Telegram app ID in Uzikext (⋮ → Library
  → Telegram → App ID; made in 2 minutes at my.telegram.org): it stays on their server. Uzikext
  reaches it through the server with its device key: no bridge address, token or second container. Sign in
  from Uzikext (⋮ → Library → Telegram → Sign in); the phone number, code
  and password are passed to Telegram once and never stored.
- **A ready-made image** (amd64 and arm64, GitHub's registry) and a short `docker-compose.yml`: two folders
  and a port. Uzikext (⋮ → Sync) says when a newer server exists.
- **Safer by default.** Only the home network may connect (`ALLOW_FROM`), device keys are stored hashed, other
  web pages can't read its answers (CORS).

## Install (QNAP Container Station, or any Docker)

1. In `docker-compose.yml`, change the two folders on the left of the `:` under `volumes`: where the server
   keeps its data (`/data`), and your music (`/music`, read-only; leave it out for no background analysis).
   Optional: a folder on another disk for a copy of the backups (`/backup-copy`).
2. **Container Station:** *Applications* → *Create* → name it `uzikext` → paste `docker-compose.yml` →
   *Create*. **Or** in a terminal, in this folder: `docker compose up -d`.
3. Open `http://<the NAS's address>:8787` in a browser: the server's page, with *Get a pairing code*.
4. In Uzikext: ⋮ → **Sync** → **Find my server** (or type the address) → the code → **Pair this device**.
   For your other devices: ⋮ → Sync → Devices → **Add a device** gives a code or a link (or the page's button: it then
   writes the code in the container's log, Container Station → the container → *Logs*).
5. Telegram (optional): ⋮ → Library → Telegram → App ID: your own Telegram app ID (my.telegram.org → API
   development tools → create an app → its api_id and api_hash), then *Sign in* → *Add to the library* →
   *Add channel* for each of your channels.
6. Background analysis: ⋮ → Analysis → *In the background*. The music folder is matched by itself once a
   device has added it (⋮ → Sync → *Music folder* says what it found).

**Updating:** when Uzikext says a newer server exists: Container Station → the application → *Recreate*
(with *pull the image*), or `docker compose pull && docker compose up -d`. The data folder is kept.

**Building it yourself** instead of pulling: `docker compose build` (the `build: .` line), as before.

## Moving your current setup (v3 → v4)

Your data folder, backups and Telegram bridge stay as they are.

1. Copy these files over the old ones (keep `data/`).
2. In your own `docker-compose.yml` (keep your paths), for the sync service:
   - **keep** `SYNC_TOKEN` for now: your devices keep working and each gets its own key by itself;
   - **remove** `MUSIC_ROOT_NAME` (found by itself now) and `MUSIC_DIR` if it's `/music`; keep the `/music`
     volume;
   - the `energy-analysis-core.js` mount can stay.
   - **Telegram, now inside the server:** move your `TG_API_ID` and `TG_API_HASH` from the bridge's service to
     this one (or enter them in Uzikext afterwards: ⋮ → Library → Telegram → App ID), mount the bridge's data folder at `/data/telegram` (it holds the sign-in and the channels'
     lists: nothing to redo), and delete the `telegram-bridge` service:
     ```yaml
     volumes:
       - /path/to/the/old/telegram-bridge/data:/data/telegram
     ```
     (Or keep the separate bridge container: `TELEGRAM_BRIDGE_URL: "http://telegram-bridge:8788"` and
     `TELEGRAM_BRIDGE_TOKEN:` its `SYNC_TOKEN`.)
3. `docker compose down && docker compose build && docker compose up -d`.
4. Update Uzikext on every device (app: rebuild; extension: reload). Each device gets its own key at its
   next sync, and Telegram moves to the server by itself (once the server's bridge is signed in: with the
   mounted folder, it already is).
5. When every device shows *Its key: its own* (⋮ → Sync): ⋮ → Sync → Devices → *Switch off* the old shared
   token.

Row-level SQLite store with delta sync for the DIGGA / Track Tagger extension (v1.2+).
Zero npm dependencies — plain Node 22 with the built-in `node:sqlite`.

## Melody score (v2.4)

Melody (`melodicScore`/`melodicHarmonicity`/`melodicMovement`, all 0-100 or unset) gets the same treatment
BPM already had: it's now stored in its own columns and threaded through `/changes`, `/energy`, and
`/energy/fetch`, instead of living only inside the blob. Previously a device that hadn't yet fetched a
given track's full blob (i.e. hadn't played it there) showed no melody score at all, even for tracks
already fully analyzed elsewhere — everything else (intensity, bpm) showed up immediately from the
lightweight summary sync, melody didn't. The column is added in place automatically on server startup,
same as `bpm`/`bpm_source` were.

Unlike bpm, there's no server-side estimator for melody — it can only ever come from decoded audio, computed
client-side during a real analysis, so there's nothing analogous to the Tier-1 kick-based backfill. For
analyses already on the server as v5 blobs (uploaded before this column existed), run once to recover the
values that are already sitting in those blobs:

```
docker compose run --rm uzikext-server node backfill-melody.js
```

Older (pre-v5) blobs have no melody data to recover — those stay blank until the track is next re-analyzed
client-side. Changed rows are re-sequenced, so connected extensions pick the values up through the normal
delta sync. Requires the matching extension update (client sends/reads melody as summary fields now, same
as bpm) — deploy both together.



The `settings` kind was added to the accepted core-record kinds — small synced preferences (currently just
the extension's waveform treble-cutoff) that behave exactly like a tag or note: last-write-wins by
timestamp, pushed and pulled through `/changes` like everything else. No schema change needed (`core` was
already a generic key/value table); this is purely a server-side allowlist update. Requires the matching
extension update — deploy both together.

## BPM (v2.2)

Server v2.1 added the `bpm` column (Tier-1, kick-interval based). v2.2 adds `bpm_source` alongside it —
`'kick'`, `'envelope'`, or `'hybrid'` — so a client can tell whether a track's tempo came from the fast,
server-backfillable Tier-1 method or the slower, audio-requiring Tier-2 pass (see the extension's
CHANGES-1.2.md for what those mean). The column is added in place automatically on server startup, same
as `bpm` was; `backfill-bpm.js` tags anything it computes as `'kick'`, since it only has kick timestamps
to work with, never decoded audio — Tier-2 can only run client-side, during a real track analysis.

## BPM (v2.1)

Tier-1 tempo is estimated from the kick timestamps already stored in every analysis (no audio needed):
the dominant inter-kick interval, folded into 84–168 BPM, with a confidence from how many kicks agree.
New uploads get it automatically. For everything already on the server, run once:

```
docker compose run --rm uzikext-server node backfill-bpm.js
```

It prints how many tracks got a tempo and how many lacked a steady kick grid (those stay blank rather
than guessing). Changed rows are re-sequenced, so connected extensions pick the values up through the
normal delta sync within a few minutes.

## Endpoints

All except `/`, `/health` and `/pair…` need a key: `Authorization: Bearer <device key>` (or `?token=` for
SSE and audio streams). The old `SYNC_TOKEN` too, while it's set and not switched off.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | the status page: what it is, its address, *Get a pairing code* |
| GET | `/health` | without a key: `{app:'uzikext', id, name, version, release}`; with one: `+ {epoch, maxSeq, core, energy, analysis, music, telegram, update, …}` |
| POST | `/pair` | `{code, name, platform}` → `{deviceId, key, server}` |
| POST | `/pair/page-code` | a code: shown while no device is paired, else written in the log |
| POST | `/pair/code` | a code for another device (from a paired one) |
| POST | `/pair/upgrade` | the shared token → a device key `{name, platform}` |
| GET | `/devices` | the paired devices |
| POST | `/devices/remove` · `/devices/rename` | `{id}` · `{id, name}` |
| POST | `/server/legacy-token` | `{on}`: accept the old shared token or not |
| GET/POST | `/server/settings` | the server's settings (name, analysis, backups, music folders), the folders it sees, Telegram's state, updates |
| POST | `/server/music/match` | look for the music folders again |
| * | `/tg/…` | the Telegram bridge, through the server |
| GET | `/changes?since=N&kinds=core\|energy&limit=M` | rows with `seq > N` (+ `epoch`); energy returns summaries only |
| POST | `/changes` | `{core:[{kind,key,ts,removed,payload}]}` → LWW apply |
| GET | `/energy?path=…` | one blob (base64 of the binary record) |
| POST | `/energy/fetch` | `{paths:[…]}` batch of blobs (max 500) |
| POST | `/energy` | `{rows:[{path,ts,intensity,blob}]}` — `Content-Encoding: gzip` accepted |
| POST | `/energy/delete` | `{paths:[…]}` tombstones |
| GET | `/events?token=…` | SSE stream: `{maxSeq, epoch}` on every write, `: ping` every 25 s |
| GET/POST | `/presence` | in-memory "who's active" heartbeat (informational) |
| GET | `/backups` | the backups, the copy's state, the schedule |
| POST | `/backups/now` | `{scope:'full'\|'data'}`: make one now |
| GET | `/backups/file?name=…` | download one |
| POST | `/backups/restore?name=…` | restore one of the backups |
| POST | `/backups/restore` | restore an uploaded archive (the body: a `.uzx` file) |

`GET /state` (the old full export) is gone: backups are archives now.

## Backups (v3)

Backups are **Uzikext archives** (`.uzx`, a plain zip you can open). One format for everything: the
server's backups, and a device's *Export everything*.

```
manifest.json            what it is: when, scope, made by whom, counts
README.txt
data/<kind>.jsonl        your data, one record per line ({key, ts, removed, payload}): tags (stars), notes,
                         played, vibes, excluded, bans, meta (metadata and your edits, beat-grid
                         corrections included), settings
analysis/energy.jsonl    each track's analysis (intensity, BPM, melody, sub-bass, explosiveness)…
analysis/energy.bin      …and its analysed waveform (energy-codec.js), at the offsets given in the .jsonl
device/…                 device exports only: that device's own settings and stores
```

**Made by the server** in `data/backups/`, each only when something changed (each name ends with the
database's identity; only this database's own backups are rotated, an earlier database's never are):

| Name | What | When | Kept |
|---|---|---|---|
| `uzikext-data-<time>-hourly.uzx` | your data | every hour | the last 48 |
| `uzikext-full-<time>-daily.uzx` | your data + the analysis | every day | 14 days, plus the last of each of 8 weeks and 12 months |
| `…-manual.uzx` | everything | ⋮ → Backups → Back up now | the last 10 |
| `uzikext-full-<time>-before-restore.uzx` | everything as it was | before every restore | the last 10 |

The first full one is made a few seconds after the server starts.

**A copy off the server's disk:** mount a second folder (another share, a USB drive, a cloud-synced folder)
and set `BACKUP_COPY_DIR` to it (see `docker-compose.yml`). Every backup is copied there as it's made, and
what's missing there is copied at start (a drive that was unplugged catches up). The folder must exist: it
isn't created, so an unplugged drive is reported in ⋮ → Backups instead of its empty mount point being
filled. The same rotation applies there.

**Restoring** (⋮ → Backups → Restore: a backup, or *Restore from a file…*; its contents are shown first) depends on where the archive
comes from:

- **A backup of this database: rolled back to.**
  - Everything in it comes back as it was then, on every device, through the normal sync.
  - What was added since the backup stays: a star added since, a new note, new metadata.
  - Plays keep the higher play count of the two.
  - A note deleted since comes back, as a new note (a deletion is final on the devices).
  - A track analysed again since keeps its newer analysis; a missing analysis comes back.
- **A "before a restore" backup: that restore is undone.** What the restore wrote, and nothing has changed
  since, goes back exactly as it was; what it brought back is removed again. Nothing else is touched.
- **Anything else** (a backup of an earlier database, after a lost disk; a device's *Export everything*):
  **merged by date.** The newer of each record wins, so nothing newer is overwritten.

Records keep their own dates: a restored star still shows the day it was starred. Before anything, the
server saves everything as it is (`…-before-restore.uzx`), so every restore can be undone. An older
`core-<time>.json` backup can be restored too, rolled back to like a backup of this database.

**A lost or replaced database:** start the server (it makes a new, empty database), then *Restore from a
file…* with the latest archive from the copy folder: it's merged by date, then each device sends back what it
has that's newer. Every database has its own identity (`epoch`). A device that sees a different one, or a
server behind where it got to, syncs from the start again and sends its own data back up, so nothing is
missed and nothing needs doing on the devices. An older copy of the database file put back in place is
recognised too (the furthest it got is also kept in `data/epoch.json` and in the copy folder) and gets a new
identity.

**Older backups** (`core-*.json`, `full-*.db`, from before v3) are left where they are; delete them when you
no longer want them. A `core-*.json` can still be restored with *Restore from a file…*.

## Security

- **Devices:** each has its own key (256 random bits), shown once at pairing and kept only by that device. The
  server keeps a keyed hash of it (HMAC-SHA256 with its own secret, made at first start). Removing a device
  ends its access at once (its live connection too).
- **Pairing codes:** 6 digits, 10 minutes, one device each, at most 5 open. 5 wrong codes in a row close
  pairing for a minute and cancel the open codes, so a code can't be guessed. The status page shows a code
  only while no device is paired (a fresh server: the first device claims it); after that, codes come from a
  paired device or the container's log.
- **Network:** only the home network by default (`ALLOW_FROM`: 10.x, 172.16–31.x, 192.168.x, 100.64–127.x for
  Tailscale-like VPNs, link-local, and the IPv6 equivalents). Still no HTTPS: don't publish port 8787 on the
  internet. For a rented server, put it behind your own HTTPS proxy and set `ALLOW_FROM: "any"` (device keys
  still apply).
- **CORS:** only Uzikext itself (the extension, the app) may read answers from a web page; other sites can't.
- Keys can be passed as `?token=` (live updates, audio streams: they can't send headers): another reason to
  stay on the home network or HTTPS.

## Environment variables

All optional. What's set in Uzikext's settings wins over them (they're the starting values).

```yaml
PORT: 8787
DATA_DIR: /data
SERVER_NAME: Uzikext server       # its name (⋮ → Sync → The server)
ALLOW_FROM: home                  # home | any | addresses/CIDRs, comma-separated (added to home)
CORS_ORIGINS: ''                  # more origins allowed to read answers
SYNC_TOKEN: ''                    # the old shared token (devices on it get their own key by themselves)
MDNS: on                          # answer "_uzikext._tcp.local" (needs network_mode: host to reach devices)
MUSIC_DIR: /music                 # (when something is mounted there)
MUSIC_ROOT_NAME: ''               # force the name of MUSIC_DIR as the devices know it (found by itself otherwise)
ANALYSIS_CONCURRENCY: 1           # ⋮ → Analysis → The server → Speed
ANALYSIS_PACE_MS: 2000
ANALYSIS_MAX_DURATION_SEC: 1200   # ⋮ → Analysis → The server → Skip tracks longer than
ANALYSIS_RESCAN_MS: 1800000       # how often the music folder is looked through (and matched again)
TG_API_ID: ''                     # a Telegram app ID (normally entered in Uzikext: ⋮ → Library → Telegram → App ID)
TG_API_HASH: ''
REFRESH_MINUTES: 60               # the bridge: how often the ticked channels are checked for new posts
SCAN_YEARS: 3                     # the bridge: how far back a newly ticked channel is scanned; 0 = all
TELEGRAM_BRIDGE_URL: ''           # a bridge elsewhere instead (e.g. http://telegram-bridge:8788); "off": none
TELEGRAM_BRIDGE_TOKEN: ''         # that bridge's SYNC_TOKEN (default: SYNC_TOKEN)
UPDATE_REPO: ''                   # owner/name on GitHub, for "update available" (set by the image build); "off"
MAX_BODY: 33554432                # 32 MB per request (energy pushes are ~150 tracks per batch, gzip'd)
BACKUP_COPY_DIR: ''               # a copy folder (⋮ → Backups → A copy on another disk: one of the folders the server sees)
BACKUP_KEEP_HOURLY: 48
BACKUP_KEEP_DAILY: 14
BACKUP_KEEP_WEEKLY: 8
BACKUP_KEEP_MONTHLY: 12
BACKUP_KEEP_MANUAL: 10
BACKUP_KEEP_BEFORE_RESTORE: 10
BACKUP_UPLOAD_MAX: 2147483648     # the largest archive that can be uploaded to restore
TOMBSTONE_TTL_MS: 7776000000
```

## Publishing the image (GitHub)

`github-workflow/server-image.yml` builds the image for amd64 and arm64 and publishes it as
`ghcr.io/<your GitHub name>/uzikext-server`. Put it in your repository as
`.github/workflows/server-image.yml` (the server's files in a `server` folder), push a tag `server-v4.0.0`,
make the package public once (GitHub → Packages → uzikext-server → settings), and put your GitHub name in
`docker-compose.yml`'s `image:`. A GitHub release for a newer `server-v…` tag is what the servers see as
"update available".
