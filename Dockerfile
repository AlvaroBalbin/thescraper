# Use official Deno image
FROM denoland/deno:1.40.0

# Set working directory
WORKDIR /app

# Copy your TS code and deps
COPY . .

# Cache dependencies
RUN deno cache index.ts

# Expose port (Railway auto-detects or set via env)
EXPOSE 8080

# Run the server
CMD ["deno", "run", "--allow-net", "--allow-env", "index.ts"]