# Use the latest Deno image
FROM denoland/deno:latest

WORKDIR /app

# Copy deno.json first (for config)
COPY deno.json .

# Install npm:puppeteer with full permissions (includes --allow-sys for homedir)
RUN deno add npm:puppeteer -A

# Copy the rest of your code
COPY . .

# Cache dependencies
RUN deno cache index.ts

EXPOSE 8080

# Run with full permissions (includes --allow-sys)
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-write", "--allow-read", "--allow-sys", "index.ts"]