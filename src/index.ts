#!/usr/bin/env node

import { createBot } from './bot.js';
import { getDiscordBotToken, getDefaultCLI, getDataDir } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('MAIN');

async function main(): Promise<void> {
  logger.log('Discord CLI Bridge starting...');
  logger.log(`Data directory: ${getDataDir()}`);
  logger.log(`Default CLI: ${getDefaultCLI()}`);

  // Get bot token
  let token: string;
  try {
    token = getDiscordBotToken();
  } catch (error) {
    logger.error((error as Error).message);
    logger.error('Set DISCORD_BOT_TOKEN environment variable');
    process.exit(1);
  }

  // Start bot
  try {
    await createBot(token);
    logger.log('Bot is running. Use /set-project to configure channels.');
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
