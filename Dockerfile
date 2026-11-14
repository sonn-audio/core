# Stage 1: Install dependencies and build the project
FROM node:24-trixie-slim AS builder
WORKDIR /app
COPY package*.json ./

# Install minimal build tooling (prebuilds should handle most deps on glibc)
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
        make \
        g++ \
        python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm config delete proxy \
    && npm config delete https-proxy \
    && npm ci
COPY . .

# The build fetches the Admin UI and Player bundles and checks them against this source
# tree's version. On dev that version is behind the code by design, so the check is waived
# there and the image carries the newest bundles — which is the point of a dev image.
# It has to be declared in this stage: ARGs do not cross stages, `.git` is not copied in, so
# the branch cannot be read here either, and without it every build looks like "not dev".
ARG BUILD_CHANNEL
ENV BUILD_CHANNEL=${BUILD_CHANNEL}
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Build crelay binary
FROM debian:trixie-slim AS crelay-builder
ARG CRELAY_REF=master
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gcc \
        libc6-dev \
        make \
        libusb-1.0-0-dev \
        libftdi-dev \
        libhidapi-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN curl -fsSL "https://github.com/ondrej1024/crelay/archive/${CRELAY_REF}.tar.gz" -o crelay.tar.gz \
    && tar -xzf crelay.tar.gz \
    && cd "crelay-${CRELAY_REF}/src" \
    && make \
    && install -m 0755 crelay /usr/local/bin/crelay

# Stage 3: Runtime image with mount tools
FROM node:24-trixie-slim AS runtime
ARG BUILD_VERSION
ARG BUILD_TIMESTAMP
# Which artifact this is: dev | testing | beta | stable. Unset means dev, because
# a build that does not claim to be a release is not one.
ARG BUILD_CHANNEL
# YouTube moves under yt-dlp constantly, so a stale pin costs real quality: on 02.04
# the only format left for an anonymous request was itag 18 — a 642 MB video file
# carrying 44 kHz AAC — where 07.04 returns itag 251, 154 MB of audio-only opus.
ARG YTDLP_VERSION=2026.07.04
ENV APP_VERSION=${BUILD_VERSION}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV BUILD_CHANNEL=${BUILD_CHANNEL}
ENV XDG_CACHE_HOME=/app/data/.cache
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        cifs-utils \
        keyutils \
        nfs-common \
        curl \
        ffmpeg \
        gpiod \
        libusb-1.0-0 \
        libftdi1 \
        libhidapi-libusb0 \
        python3 \
        # Spotify's Soloist is supplied by the user, not shipped, but it can only run here: it
        # links against libatomic and reaches a sound card through libpulse, which it dlopens and
        # points at this server's own. No sound daemon is involved, and none is installed.
        libatomic1 \
        libpulse0 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -L -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
    && chmod +x /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=crelay-builder /usr/local/bin/crelay /usr/local/bin/crelay
RUN chmod +x /usr/local/bin/crelay \
    && /usr/local/bin/crelay --help >/dev/null || true
# The Widevine CDM Apple Music and Amazon Music are decrypted with. It comes in as build secrets
# so it is in neither the repository nor the build context, and it lands beside the code rather
# than under /app/data, which is a volume and would hide it. Both secrets are optional: a build
# without them — a fork, a local `docker build` — simply carries no CDM, and the server then asks
# for an upload as it always did. A set uploaded through the admin screen still wins over this one.
RUN --mount=type=secret,id=widevine_private_key \
    --mount=type=secret,id=widevine_client_id \
    if [ -s /run/secrets/widevine_private_key ] && [ -s /run/secrets/widevine_client_id ]; then \
        install -d -o node -g node /app/widevine_cdm \
        && install -o node -g node -m 0644 /run/secrets/widevine_private_key /app/widevine_cdm/private_key.pem \
        && install -o node -g node -m 0644 /run/secrets/widevine_client_id /app/widevine_cdm/client_id.bin \
        && echo "widevine cdm: bundled"; \
    else \
        echo "widevine cdm: not provided, image carries none"; \
    fi
RUN mkdir -p /app/data/.cache && chown -R node:node /app/data
# Start the application
CMD ["node", "dist/server.js"]
