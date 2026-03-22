FROM node:22-bookworm

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Codex CLI
RUN npm install -g @openai/codex

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ src/

# Build TypeScript
RUN npx tsc

# Create data directory
RUN mkdir -p /data

ENV DATA_DIR=/data
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
