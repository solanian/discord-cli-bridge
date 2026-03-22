import { createLogger } from './logger.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';
import type { CLIAdapter, CLISession, OutputChunk } from './adapters/base.js';
import type { CLIType } from './config.js';
import {
  createSession as dbCreateSession,
  getSession,
  updateSessionStatus,
  updateSessionCLIId,
} from './database.js';

const logger = createLogger('SESSION');

// Active sessions keyed by thread ID
const activeSessions = new Map<string, CLISession>();

// Adapters keyed by CLI type
const adapters: Record<CLIType, CLIAdapter> = {
  claude: new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
};

// Message queues for threads with active sessions
const messageQueues = new Map<string, string[]>();

export interface StartSessionParams {
  threadId: string;
  channelId: string;
  prompt: string;
  cliType: CLIType;
  workingDirectory: string;
  sessionId?: string;  // resume existing
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  onOutput: (chunk: OutputChunk) => void;
  onComplete: (result: { sessionId?: string; durationMs?: number }) => void;
  onError: (error: Error) => void;
}

export async function startSession(params: StartSessionParams): Promise<void> {
  const {
    threadId,
    channelId,
    prompt,
    cliType,
    workingDirectory,
    sessionId,
    model,
    effort,
    maxBudgetUsd,
    onOutput,
    onComplete,
    onError,
  } = params;

  // Check if there's already an active session for this thread
  const existing = activeSessions.get(threadId);
  if (existing && existing.isRunning()) {
    // Queue the message
    logger.log(`Session active for ${threadId}, queuing message`);
    const queue = messageQueues.get(threadId) || [];
    queue.push(prompt);
    messageQueues.set(threadId, queue);
    return;
  }

  const adapter = adapters[cliType];
  if (!adapter) {
    onError(new Error(`Unknown CLI type: ${cliType}`));
    return;
  }

  const isAvailable = await adapter.isAvailable();
  if (!isAvailable) {
    onError(new Error(`${cliType} CLI is not installed or not in PATH`));
    return;
  }

  logger.log(`Starting ${cliType} session for thread ${threadId} in ${workingDirectory}`);

  try {
    const session = await adapter.start({
      prompt,
      workingDirectory,
      sessionId,
      model,
      effort,
      maxBudgetUsd,
    });

    activeSessions.set(threadId, session);

    // Save to database
    dbCreateSession({
      threadId,
      channelId,
      cliType,
      directory: workingDirectory,
      cliSessionId: sessionId,
      firstPrompt: prompt,
    });
    updateSessionStatus(threadId, 'active');

    session.onOutput((chunk) => {
      onOutput(chunk);

      // Update session ID when we get it from the CLI
      const cliSid = session.getSessionId();
      if (cliSid) {
        updateSessionCLIId(threadId, cliSid);
      }
    });

    session.onComplete(async (result) => {
      activeSessions.delete(threadId);
      updateSessionStatus(threadId, 'idle');

      if (result.sessionId) {
        updateSessionCLIId(threadId, result.sessionId);
      }

      onComplete(result);

      // Process queued messages
      await processQueue(threadId, params);
    });

    session.onError((error) => {
      activeSessions.delete(threadId);
      updateSessionStatus(threadId, 'error');
      onError(error);
    });
  } catch (error) {
    activeSessions.delete(threadId);
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}

async function processQueue(threadId: string, originalParams: StartSessionParams): Promise<void> {
  const queue = messageQueues.get(threadId);
  if (!queue || queue.length === 0) {
    messageQueues.delete(threadId);
    return;
  }

  const nextPrompt = queue.shift()!;
  if (queue.length === 0) {
    messageQueues.delete(threadId);
  }

  // Get the stored session for resume
  const dbSession = getSession(threadId);
  const resumeSessionId = dbSession?.cli_session_id || undefined;

  logger.log(`Processing queued message for ${threadId} (queue remaining: ${queue?.length || 0})`);

  await startSession({
    ...originalParams,
    prompt: nextPrompt,
    sessionId: resumeSessionId,
  });
}

export async function abortSession(threadId: string): Promise<boolean> {
  const session = activeSessions.get(threadId);
  if (!session) {
    return false;
  }

  logger.log(`Aborting session for thread ${threadId}`);
  await session.abort();
  activeSessions.delete(threadId);
  updateSessionStatus(threadId, 'aborted');

  // Clear message queue
  messageQueues.delete(threadId);

  return true;
}

export function isSessionActive(threadId: string): boolean {
  const session = activeSessions.get(threadId);
  return session?.isRunning() || false;
}

export function getQueueLength(threadId: string): number {
  return messageQueues.get(threadId)?.length || 0;
}

export function getAdapter(cliType: CLIType): CLIAdapter {
  return adapters[cliType];
}
