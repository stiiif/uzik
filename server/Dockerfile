FROM node:22-alpine
# ffmpeg: the only non-JS dependency, needed to decode compressed audio (mp3/flac/etc.) server-side for
# background analysis — Node has no built-in audio decoder. It only runs when a music folder is mounted.
RUN apk add --no-cache ffmpeg python3
# The Telegram bridge (telegram-bridge/, Python), run by the server itself once the user has entered their
# own Telegram app ID in Uzikext (Sync → On the server → Telegram). In its own Python environment.
COPY telegram-bridge/requirements.txt /tmp/tg-requirements.txt
RUN apk add --no-cache --virtual .build gcc musl-dev python3-dev libffi-dev \
 && python3 -m venv /opt/tg && /opt/tg/bin/pip install --no-cache-dir -r /tmp/tg-requirements.txt \
 && apk del .build && rm /tmp/tg-requirements.txt
WORKDIR /app
COPY *.js ./
COPY telegram-bridge/app.py telegram-bridge/requirements.txt ./telegram-bridge/
COPY telegram-bridge/static ./telegram-bridge/static
# energy-analysis-core.js above is a BUILD-TIME FALLBACK only — the actual DSP algorithm, baked in so the
# image works out of the box. A bind-mounted copy from the uzikext repo (docker-compose.yml) overrides it at
# container start, so an algorithm edit in uzikext takes effect on a restart — no rebuild.
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
