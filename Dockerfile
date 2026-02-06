# Use the latest Deno image
FROM denoland/deno:latest

WORKDIR /app

# Copy deno.json (for npm config)
COPY deno.json .

# Install npm:puppeteer (auto-downloads Chromium via postinstall)
RUN deno add npm:puppeteer

# Copy the rest of your code
COPY . .

# Cache dependencies (creates fresh deno.lock)
RUN deno cache index.ts

EXPOSE 8080

# Run with permissions
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-write", "--allow-read", "index.ts"]