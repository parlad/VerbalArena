# worker/url-ingest/Dockerfile
#
# Slim Node 20 base + yt-dlp + ffmpeg.
# Build:  docker build -t va-url-ingest .
# Run:    docker run --rm \
#           -e SUPABASE_URL=... \
#           -e SUPABASE_SERVICE_ROLE_KEY=... \
#           va-url-ingest

FROM node:20-bookworm-slim

# yt-dlp + ffmpeg + ca-certificates for HTTPS to Supabase Storage
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      python3 \
      python3-pip \
      curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./

ENV NODE_ENV=production
CMD ["node", "index.js"]
