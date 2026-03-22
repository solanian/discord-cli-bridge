#!/usr/bin/env node

import { createBot } from './bot.js';
import { getDiscordBotToken, getDefaultCLI, getDataDir } from './config.js';
import { createLogger } from './logger.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';

const logger = createLogger('MAIN');

async function main(): Promise<void> {
  logger.log('Discord CLI Bridge starting...');
  logger.log(`Data directory: ${getDataDir()}`);
  logger.log(`Default CLI: ${getDefaultCLI()}`);

  // Check CLI availability
  const claudeAdapter = new ClaudeCodeAdapter();
  const codexAdapter = new CodexAdapter();

  const [claudeAvailable, codexAvailable] = await Promise.all([
    claudeAdapter.isAvailable(),
    codexAdapter.isAvailable(),
  ]);

  logger.log(`Claude Code CLI: ${claudeAvailable ? 'available' : 'not found'}`);
  logger.log(`Codex CLI: ${codexAvailable ? 'available' : 'not found'}`);

  if (!claudeAvailable && !codexAvailable) {
    logger.error('Neither Claude Code nor Codex CLI is available. Please install at least one.');
    process.exit(1);
  }

  // Get bot token
  let token: string;
  try {
    token = getDiscordBotToken();
  } catch (error) {
    logger.error((error as Error).message);
    logger.error('Set DISCORD_BOT_TOKEN environment variable or create a .env file');
    process.exit(1);
  }

  // Start bot
  try {
    await createBot(token);
    logger.log('Bot is running. Send messages in configured channels to start sessions.');
    logger.log('Use /set-project to configure a channel with a project directory.');
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
