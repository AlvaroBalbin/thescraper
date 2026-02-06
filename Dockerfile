# Use the latest Deno image
FROM denoland/deno:latest

WORKDIR /app

# Copy deno.json first
COPY deno.json .

# Install npm:puppeteer with full permissions (required for postinstall + Chromium download)
RUN deno add npm:puppeteer --allow-all

# Copy the rest of your code
COPY . .

# Cache dependencies
RUN deno cache index.ts

EXPOSE 8080

# Run the server with full permissions
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-write", "--allow-read", "--allow-sys", "index.ts"]