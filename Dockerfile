# Album player: static web app + a small stdlib-only Python server (Range requests, library scan).
# Mount your music collection read-only at /music; nothing else is needed.
FROM python:3.12-alpine

ENV HOST=0.0.0.0 \
    PORT=5173 \
    MUSIC_DIR=/music \
    RESCAN_SECONDS=600 \
    QUIET=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY index.html ./
COPY css/ css/
COPY js/ js/
COPY vendor/ vendor/
COPY scripts/ scripts/

# Unprivileged by default. If your files aren't readable by uid 1000, override the user
# (compose: user: "1001:1001") rather than loosening permissions on the collection.
RUN adduser -D -u 1000 player && mkdir -p /music
USER player

EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["python3", "scripts/serve.py"]
