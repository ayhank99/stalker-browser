FROM node:20-bookworm-slim

WORKDIR /app

# Python/FFmpeg (YouTube ve compat proxy icin gerekli)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip curl ca-certificates --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip3 install -r requirements.txt --break-system-packages \
    && pip3 install --upgrade yt-dlp --break-system-packages

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV ENABLE_TV_SERVER=1
ENV TV_DELIVERY_MODE=proxy
ENV ENABLE_YOUTUBE_PROXY=1
ENV YOUTUBE_PROXY_PORT=5000

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]
