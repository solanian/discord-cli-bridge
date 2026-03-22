import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type TextChannel,
  type Client,
} from 'discord.js';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from './logger.js';
import { setChannelDirectory, getChannelConfig } from './database.js';
import type { CLIType } from './config.js';

const logger = createLogger('SETUP');

/**
 * Ensure a category exists for this bot's CLI type.
 * Creates "Claude Code" or "Codex" category.
 */
async function ensureCategory(guild: Guild, cliType: CLIType): Promise<CategoryChannel> {
  const categoryName = cliType === 'claude' ? 'Claude Code' : 'Codex';

  const existing = guild.channels.cache.find(
    (ch): ch is CategoryChannel =>
      ch.type === ChannelType.GuildCategory &&
      ch.name.toLowerCase() === categoryName.toLowerCase(),
  );

  if (existing) {
    logger.log(`Found existing category: ${existing.name}`);
    return existing;
  }

  logger.log(`Creating category: ${categoryName}`);
  return guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  });
}

/**
 * Create a project channel under the bot's category.
 * Channel name is derived from the directory basename.
 */
async function ensureProjectChannel(
  guild: Guild,
  category: CategoryChannel,
  directory: string,
  cliType: CLIType,
): Promise<TextChannel> {
  const baseName = path.basename(directory);
  const channelName = baseName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);

  // Check if channel already exists under this category
  const existing = category.children.cache.find(
    (ch): ch is TextChannel =>
      ch.type === ChannelType.GuildText &&
      ch.name === channelName,
  );

  if (existing) {
    // Ensure DB mapping exists
    const config = getChannelConfig(existing.id);
    if (!config) {
      setChannelDirectory(existing.id, directory, cliType);
      logger.log(`Re-registered existing channel #${channelName} → ${directory}`);
    }
    return existing;
  }

  logger.log(`Creating channel #${channelName} → ${directory}`);
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category,
    topic: `${cliType} · ${directory}`,
  });

  setChannelDirectory(channel.id, directory, cliType);
  return channel;
}

/**
 * Auto-setup: scan DEFAULT_PROJECT_DIR or PROJECT_DIRS,
 * create category + channels for each project directory.
 *
 * PROJECT_DIRS: comma-separated list of absolute paths
 * DEFAULT_PROJECT_DIR: single directory (creates one channel)
 */
export async function autoSetupChannels(client: Client<true>, cliType: CLIType): Promise<void> {
  const projectDirs = getProjectDirectories();
  if (projectDirs.length === 0) {
    logger.log('No project directories configured, skipping auto-setup');
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    logger.log(`Setting up channels in guild: ${guild.name}`);
    const category = await ensureCategory(guild, cliType);

    for (const dir of projectDirs) {
      if (!fs.existsSync(dir)) {
        logger.warn(`Directory does not exist, skipping: ${dir}`);
        continue;
      }
      await ensureProjectChannel(guild, category, dir, cliType);
    }
  }

  logger.log(`Auto-setup complete: ${projectDirs.length} project(s) configured`);
}

function getProjectDirectories(): string[] {
  // PROJECT_DIRS takes priority: comma-separated list
  const projectDirs = process.env['PROJECT_DIRS'];
  if (projectDirs) {
    return projectDirs.split(',').map(d => d.trim()).filter(Boolean);
  }

  // Fall back to DEFAULT_PROJECT_DIR as single entry
  const defaultDir = process.env['DEFAULT_PROJECT_DIR'];
  if (defaultDir) {
    return [defaultDir];
  }

  return [];
}
