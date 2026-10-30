# Trinetra exam server (backend API, candidate web app, proctor console).
# The desktop app is built separately with `npm run dist`; this image is the central server.
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4100 \
    TRINETRA_DATA_DIR=/data \
    # TLS is terminated by the reverse proxy (see deploy/docker-compose.yml)
    TRINETRA_DISABLE_HTTPS=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY assets ./assets
COPY scripts ./scripts
RUN node scripts/fetch-models.js || echo "phone-detection model will load from the CDN at runtime"

VOLUME ["/data"]
EXPOSE 4100
CMD ["node", "src/backend/server.js"]
