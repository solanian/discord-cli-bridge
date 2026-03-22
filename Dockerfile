FROM node:22-bookworm

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI and Codex CLI globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# Create mount points owned by node user (UID 1000, already in node image)
RUN mkdir -p /data /workspace && chown -R node:node /app /data /workspace

# Run as non-root 'node' user (--dangerously-skip-permissions requires non-root)
USER node

ENV DATA_DIR=/data
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
