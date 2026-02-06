# Use official Deno image
FROM denoland/deno:latest

# Set working directory
WORKDIR /app

# Install Puppeteer Chromium during build
RUN PUPPETEER_PRODUCT=chrome deno run -A --unstable https://deno.land/x/puppeteer@16.2.0/install.ts

# Copy your TS code and deps
COPY . .

# Cache dependencies
RUN deno cache index.ts

# Expose port (Railway auto-detects or set via env)
EXPOSE 8080

# Run the server with all necessary permissions
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-write", "--allow-read", "index.ts"]