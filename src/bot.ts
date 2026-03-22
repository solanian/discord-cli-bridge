import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { createLogger } from './logger.js';
import { initDatabase, closeDatabase } from './database.js';
import { handleMessage } from './message-handler.js';
import { registerSlashCommands, handleInteraction } from './slash-commands.js';
import { reconnectSessions } from './session-manager.js';

const logger = createLogger('BOT');

export async function createBot(token: string): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
    ],
  });

  // Initialize database
  initDatabase();

  // Ready event
  client.once(Events.ClientReady, async (c) => {
    logger.log(`Bot logged in as ${c.user.tag}`);
    logger.log(`Connected to ${c.guilds.cache.size} guild(s)`);

    // Check agent server connections
    await reconnectSessions();

    // Register slash commands
    await registerSlashCommands(c);
  });

  // Message handler
  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessage(message, client);
    } catch (error) {
      logger.error('Message handler error:', error);
      try {
        await message.reply({
          content: `Error: ${(error instanceof Error ? error.message : String(error)).slice(0, 1800)}`,
        });
      } catch {
        // Ignore send failures
      }
    }
  });

  // Interaction handler (slash commands)
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (error) {
      logger.error('Interaction handler error:', error);
    }
  });

  // Error handling
  client.on(Events.Error, (error) => {
    logger.error('Discord client error:', error);
  });

  // Shutdown handling
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down...`);
    closeDatabase();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Login
  await client.login(token);

  return client;
}
