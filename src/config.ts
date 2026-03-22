import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export type CLIType = 'claude' | 'codex';

export interface AppConfig {
  discordBotToken: string;
  defaultCLI: CLIType;
  dataDir: string;
}

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.discord-cli-bridge');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getDataDir(): string {
  const dir = process.env['DATA_DIR'] || DEFAULT_DATA_DIR;
  ensureDir(dir);
  return dir;
}

export function getDiscordBotToken(): string {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is required');
  }
  return token;
}

/**
 * BOT_CLI_TYPE env var locks this bot instance to a single CLI tool.
 * Each container runs one bot dedicated to one CLI.
 */
export function getDefaultCLI(): CLIType {
  const cli = (process.env['BOT_CLI_TYPE'] || process.env['DEFAULT_CLI'] || 'claude').toLowerCase();
  if (cli === 'codex') return 'codex';
  return 'claude';
}

export function getLogFilePath(): string {
  return path.join(getDataDir(), 'bridge.log');
}

export function getDatabasePath(): string {
  return path.join(getDataDir(), 'bridge.db');
}
