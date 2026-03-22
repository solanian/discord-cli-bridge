import {
  type ThreadChannel,
  type Message,
  MessageFlags,
} from 'discord.js';

const DISCORD_MAX_LENGTH = 2000;
const CODE_BLOCK_OVERHEAD = 8; // ```\n...\n```

/**
 * Split a long message into Discord-safe chunks (< 2000 chars).
 * Tries to split at newlines when possible.
 */
export function splitMessage(text: string, maxLength = DISCORD_MAX_LENGTH - 50): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex < maxLength / 2) {
      // If newline is too early, split at space
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex < maxLength / 2) {
      // Hard split
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * Send a message to a thread, splitting if necessary.
 */
export async function sendThreadMessage(
  thread: ThreadChannel,
  content: string,
): Promise<Message[]> {
  const chunks = splitMessage(content);
  const messages: Message[] = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const msg = await thread.send({ content: chunk });
    messages.push(msg);
  }

  return messages;
}

/**
 * Wrap text in a Discord code block.
 */
export function codeBlock(text: string, lang = ''): string {
  // Escape any existing triple backticks
  const escaped = text.replace(/```/g, '`\u200b``');
  return `\`\`\`${lang}\n${escaped}\n\`\`\``;
}

/**
 * Format a tool use event for Discord display.
 */
export function formatToolUse(toolName: string, input?: unknown): string {
  let detail = '';
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // Show key details for common tools
    if (obj['command']) {
      detail = `: \`${String(obj['command']).slice(0, 100)}\``;
    } else if (obj['file_path'] || obj['path']) {
      detail = `: \`${String(obj['file_path'] || obj['path']).slice(0, 100)}\``;
    } else if (obj['pattern']) {
      detail = `: \`${String(obj['pattern']).slice(0, 100)}\``;
    }
  }
  return `┣ **${toolName}**${detail}`;
}

export const SILENT_FLAGS = MessageFlags.SuppressNotifications;
