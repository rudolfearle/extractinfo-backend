# Use Node 20 slim
FROM node:20-slim

WORKDIR /usr/src/app

# Ensure Puppeteer will not attempt to download Chromium during npm install
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Path we'll set for the chromium executable (adjust if your distro uses another path)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Allow larger response headers (Yahoo returns big Set-Cookie chains)
ENV NODE_OPTIONS="--max-http-header-size=65536"
ENV PORT=8080

# Install system deps and chromium (no-install-recommends keeps image smaller)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget gnupg2 lsb-release xdg-utils \
    chromium \
    fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
    libpango-1.0-0 libpangocairo-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
    libxss1 libxtst6 \
  && rm -rf /var/lib/apt/lists/*

# Copy package manifests and install production deps
COPY package*.json ./

# Install only production dependencies; Puppeteer won't download Chromium because of env above
RUN npm ci --omit=dev

# Copy the app source
COPY . .

# Expose and default command
EXPOSE 8080
CMD ["node", "server.js"]
