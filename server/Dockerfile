FROM node:22-alpine
# ffmpeg: the only non-JS dependency, needed to decode compressed audio (mp3/flac/etc.) server-side for
# background analysis — Node has no built-in audio decoder. It only runs when a music folder is mounted.
RUN apk add --no-cache ffmpeg python3
# The Telegram bridge (telegram-bridge/, Python), run by the server itself once the user has entered their
# own Telegram app ID in Uzikext (Sync → On the server → Telegram). In its own Python environment.
COPY telegram-bridge/requirements.txt /tmp/tg-requirements.txt
# cryptg: Telegram's decryption in compiled code (hundreds of MB/s, against well under 1 MB/s in plain Python).
# Alpine has no ready-made build of it, so it's compiled here (Rust); if that fails, the bridge uses the
# system's OpenSSL instead (about 6 MB/s, still plenty for playing tracks).
RUN apk add --no-cache --virtual .build gcc musl-dev python3-dev libffi-dev cargo \
 && python3 -m venv /opt/tg && /opt/tg/bin/pip install --no-cache-dir -r /tmp/tg-requirements.txt \
 && (/opt/tg/bin/pip install --no-cache-dir cryptg || echo "cryptg not built: the bridge decrypts with OpenSSL") \
 && apk del .build && rm -rf /tmp/tg-requirements.txt /root/.cargo
WORKDIR /app
COPY *.js ./
COPY telegram-bridge/app.py telegram-bridge/requirements.txt ./telegram-bridge/
COPY telegram-bridge/static ./telegram-bridge/static
# energy-analysis-core.js above: the analysis algorithm, the same file as Uzikext's own (ui/), copied here when
# it changes, so the server analyses exactly as the app and the extension do.
# UPDATE_REPO: the GitHub repository this image is built from (owner/name): the server looks at its releases
# once a day and says when a newer one exists (Uzikext's ⋮ → Sync, status page). Set by the build workflow.
ARG UPDATE_REPO=""
ENV UPDATE_REPO=${UPDATE_REPO}
ENV PORT=8787
ENV DATA_DIR=/data
ENV NODE_NO_WARNINGS=1
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD wget -q -O /dev/null http://127.0.0.1:8787/health || exit 1
CMD ["node", "server.js"]
