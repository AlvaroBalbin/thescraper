# Use the latest Deno image
FROM denoland/deno:latest

WORKDIR /app

# Copy deno.json first
COPY deno.json .

# Install npm:puppeteer with script allowance (for postinstall to download Chromium)
RUN deno add npm:puppeteer --allow-scripts

# Copy the rest of your code
COPY . .

# Cache dependencies
RUN deno cache index.ts

EXPOSE 8080

# Run with full permissions (includes --allow-sys)
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-write", "--allow-read", "--allow-sys", "index.ts"]