FROM node:22-bookworm-slim

WORKDIR /app

# Cài đặt đúng phiên bản pnpm theo package.json
RUN npm install -g pnpm@10.34.6

# Cài đặt các thư viện hệ thống cần thiết cho Playwright và FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package.json pnpm-lock.yaml ./

# Cài đặt dependencies
RUN pnpm install --frozen-lockfile

# Đặt biến môi trường lưu browser cục bộ ngay trong node_modules (.local-browsers)
ENV PLAYWRIGHT_BROWSERS_PATH=0

# Cài đặt Chromium và Chromium Headless Shell cho Playwright
RUN pnpm exec playwright install chromium chromium-headless-shell

# Copy toàn bộ mã nguồn
COPY . .

# Build mã nguồn TypeScript sang JavaScript (dist/)
RUN pnpm run build

ENV NODE_ENV=production
ENV PORT=4000
ENV RUN_WORKER_IN_PROCESS=true

EXPOSE 4000

# Chạy migration database Neon và khởi động API + Worker
CMD ["sh", "-c", "pnpm db:migrate && node dist/main.js"]
