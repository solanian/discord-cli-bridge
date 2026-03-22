import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type Client,
} from 'discord.js';
import { createLogger } from './logger.js';
import { getChannelConfig, getSession } from './database.js';
import { startSession, isSessionActive } from './session-manager.js';
import { sendThreadMessage, formatToolUse, SILENT_FLAGS } from './discord-utils.js';
import { getDefaultCLI } from './config.js';
import type { OutputChunk } from './adapters/base.js';
import fs from 'node:fs';

const logger = createLogger('MSG');

// Debounce text output to avoid flooding Discord
const textBuffers = new Map<string, { text: string; timer: NodeJS.Timeout | null }>();
const TEXT_DEBOUNCE_MS = 1500;

function flushTextBuffer(thread: ThreadChannel, threadId: string): void {
  const buf = textBuffers.get(threadId);
  if (!buf) return;

  // Clear any pending timer
  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }

  if (!buf.text.trim()) return;

  const text = buf.text;
  buf.text = '';

  sendThreadMessage(thread, `▸ ${text}`).catch((err) => {
    logger.error(`Failed to send text to thread ${threadId}:`, err);
  });
}

function appendTextBuffer(thread: ThreadChannel, threadId: string, text: string): void {
  let buf = textBuffers.get(threadId);
  if (!buf) {
    buf = { text: '', timer: null };
    textBuffers.set(threadId, buf);
  }

  buf.text += text;

  // Clear existing timer
  if (buf.timer) {
    clearTimeout(buf.timer);
  }

  // If buffer is getting large, flush immediately
  if (buf.text.length > 1500) {
    flushTextBuffer(thread, threadId);
    return;
  }

  // Otherwise debounce
  buf.timer = setTimeout(() => {
    flushTextBuffer(thread, threadId);
  }, TEXT_DEBOUNCE_MS);
}

function handleOutputChunk(thread: ThreadChannel, threadId: string, chunk: OutputChunk): void {
  switch (chunk.type) {
    case 'text': {
      appendTextBuffer(thread, threadId, chunk.content);
      break;
    }
    case 'tool_use': {
      // Flush any pending text first
      flushTextBuffer(thread, threadId);
      const toolMsg = formatToolUse(chunk.content, chunk.metadata?.input);
      sendThreadMessage(thread, toolMsg).catch((err) => {
        logger.error(`Failed to send tool use to thread ${threadId}:`, err);
      });
      break;
    }
    case 'error': {
      flushTextBuffer(thread, threadId);
      sendThreadMessage(thread, `⚠ Error: ${chunk.content.slice(0, 1800)}`).catch((err) => {
        logger.error(`Failed to send error to thread ${threadId}:`, err);
      });
      break;
    }
    case 'result': {
      // Flush remaining text
      flushTextBuffer(thread, threadId);
      break;
    }
    case 'system':
    case 'tool_result': {
      // Don't display these by default
      break;
    }
  }
}

export async function handleMessage(message: Message, client: Client): Promise<void> {
  // Ignore bot's own messages
  if (message.author.id === client.user?.id) return;
  // Ignore other bots
  if (message.author.bot) return;

  const channel = message.channel;

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
  ].includes(channel.type);

  if (isThread) {
    await handleThreadMessage(message, channel as ThreadChannel);
    return;
  }

  if (channel.type === ChannelType.GuildText) {
    await handleChannelMessage(message, channel as TextChannel);
    return;
  }
}

async function handleThreadMessage(message: Message, thread: ThreadChannel): Promise<void> {
  // Check if this thread has an existing session
  const session = getSession(thread.id);
  if (!session) {
    logger.log(`No session for thread ${thread.id}, ignoring`);
    return;
  }

  const prompt = message.content?.trim();
  if (!prompt) return;

  // Show typing indicator
  await thread.sendTyping();

  const startTime = Date.now();

  // If session is already running (persistent process), send() will deliver
  // the message via stdin. Otherwise startSession creates a new process.
  await startSession({
    threadId: thread.id,
    channelId: session.channel_id,
    prompt,
    cliType: session.cli_type,
    workingDirectory: session.directory,
    onOutput: (chunk) => handleOutputChunk(thread, thread.id, chunk),
    onComplete: (result) => {
      flushTextBuffer(thread, thread.id);
      const elapsed = Date.now() - startTime;
      const elapsedStr = formatDuration(elapsed);
      const footer = `${session.directory.split('/').pop()} · ${elapsedStr} · ${session.cli_type}`;
      sendThreadMessage(thread, footer).catch((err) => {
        logger.error(`Failed to send footer:`, err);
      });
    },
    onError: (error) => {
      flushTextBuffer(thread, thread.id);
      sendThreadMessage(thread, `⚠ Error: ${error.message.slice(0, 1800)}`).catch((err) => {
        logger.error(`Failed to send error:`, err);
      });
    },
  });
}

async function handleChannelMessage(message: Message, textChannel: TextChannel): Promise<void> {
  const channelConfig = getChannelConfig(textChannel.id);

  // Only respond in channels registered in THIS bot's database.
  // No fallback - prevents two bots from fighting over the same channel.
  if (!channelConfig) {
    logger.log(`No config for channel ${textChannel.id}, ignoring`);
    return;
  }

  const directory = channelConfig.directory;
  const cli_type = channelConfig.cli_type;
  const model = channelConfig.model || undefined;
  const effort = channelConfig.effort || undefined;
  const maxBudgetUsd = channelConfig.max_budget_usd || undefined;

  if (!fs.existsSync(directory)) {
    await message.reply({
      content: `Directory does not exist: \`${directory}\``,
      flags: SILENT_FLAGS,
    });
    return;
  }

  const prompt = message.content?.trim();
  if (!prompt) return;

  // Create a thread for this conversation
  const threadName = prompt.replace(/\s+/g, ' ').slice(0, 80) || 'CLI session';
  const thread = await message.startThread({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
  });

  // Add user to thread
  await thread.members.add(message.author.id);

  logger.log(`Created thread "${thread.name}" (${thread.id}) for ${cli_type} in ${directory}`);

  // Show typing
  await thread.sendTyping();
  const typingInterval = setInterval(() => {
    thread.sendTyping().catch(() => {});
  }, 7000);

  const startTime = Date.now();

  await startSession({
    threadId: thread.id,
    channelId: textChannel.id,
    prompt,
    cliType: cli_type,
    workingDirectory: directory,
    model,
    effort,
    maxBudgetUsd,
    onOutput: (chunk) => handleOutputChunk(thread, thread.id, chunk),
    onComplete: (result) => {
      clearInterval(typingInterval);
      flushTextBuffer(thread, thread.id);
      const elapsed = Date.now() - startTime;
      const elapsedStr = formatDuration(elapsed);
      const projectName = directory.split('/').pop() || 'project';
      const footer = `${projectName} · ${elapsedStr} · ${cli_type}`;
      sendThreadMessage(thread, footer).catch((err) => {
        logger.error(`Failed to send footer:`, err);
      });
    },
    onError: (error) => {
      clearInterval(typingInterval);
      flushTextBuffer(thread, thread.id);
      sendThreadMessage(thread, `⚠ Error: ${error.message.slice(0, 1800)}`).catch((err) => {
        logger.error(`Failed to send error:`, err);
      });
    },
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}
