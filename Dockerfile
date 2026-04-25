FROM node:20-slim

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends ffmpeg wget curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/ ./public/

RUN mkdir -p /app/data_local/uploads

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
