# StreamLoop — Google Cloud Run Dockerfile
# FFmpeg pre-installed, Node.js 20, lightweight

FROM node:20-slim

# Install FFmpeg + wget (needed for video URL downloads)
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends ffmpeg wget curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install dependencies first (Docker cache layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy app source
COPY server.js ./
COPY public/ ./public/

# Create data directories
# Note: Cloud Run has ephemeral disk by default.
# For persistent storage, mount a Cloud Storage bucket via gcsfuse
# OR use Cloud Run's new volume mounts (--add-volume flag)
RUN mkdir -p /app/data_local/uploads

# Cloud Run sets PORT env var automatically
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/api/health || exit 1

EXPOSE 8080

CMD ["node", "server.js"]
