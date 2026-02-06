# Use the latest Deno image
FROM denoland/deno:latest

WORKDIR /app

# === CRITICAL: Install all libraries Chromium/Puppeteer needs (added libgobject-2.0-0 + extras) ===
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgobject-2.0-0 \ 
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libuuid1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy deno.json first
COPY deno.json .

# Install puppeteer (downloads Chromium)
RUN deno add npm:puppeteer --allow-scripts

# Copy the rest of your code
COPY . .

# Cache dependencies
RUN deno cache index.ts

EXPOSE 8080

# Full permissions
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-write", "--allow-read", "--allow-sys", "--allow-ffi", "index.ts"]