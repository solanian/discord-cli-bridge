import { createLogger } from './logger.js';
import { ClaudeAgentSession } from './adapters/claude-agent.js';
import { CodexAppServerSession } from './adapters/codex-appserver.js';
import type { CLISession, OutputChunk } from './adapters/base.js';
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

const SESSION_PREFIX = 'dcb-';

export interface StartSessionParams {
  threadId: string;
  channelId: string;
  prompt: string;
  cliType: CLIType;
  workingDirectory: string;
  sessionId?: string;
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

  // If there's an active session in memory, send follow-up
  const existing = activeSessions.get(threadId);
  if (existing && existing.isRunning()) {
    logger.log(`Sending follow-up to existing session for ${threadId}`);
    try {
      await existing.send(prompt);
    } catch (error) {
      logger.error(`Failed to send follow-up:`, error);
      activeSessions.delete(threadId);
      // Retry as new session
      return startSession(params);
    }
    return;
  }

  logger.log(`Starting ${cliType} session for thread ${threadId}`);

  try {
    let session: CLISession;

    if (cliType === 'codex') {
      const codexSession = new CodexAppServerSession({
        prompt, workingDirectory, model, effort, maxBudgetUsd,
        sessionId,  // pass resume ID if available
      });
      codexSession.onOutput(onOutput);
      codexSession.onComplete((result) => {
        // Save session ID for future resume
        if (result.sessionId) updateSessionCLIId(threadId, result.sessionId);
        updateSessionStatus(threadId, 'idle');
        onComplete(result);
      });
      codexSession.onError((error) => {
        updateSessionStatus(threadId, 'error');
        onError(error);
      });
      await codexSession.start();
      session = codexSession;
    } else {
      const claudeSession = new ClaudeAgentSession({
        prompt, workingDirectory, model, effort, maxBudgetUsd,
        sessionId,  // pass resume ID if available
      });
      claudeSession.onOutput(onOutput);
      claudeSession.onComplete((result) => {
        // Save session ID for future resume
        if (result.sessionId) updateSessionCLIId(threadId, result.sessionId);
        updateSessionStatus(threadId, 'idle');
        onComplete(result);
      });
      claudeSession.onError((error) => {
        updateSessionStatus(threadId, 'error');
        onError(error);
      });
      await claudeSession.start();
      session = claudeSession;
    }

    activeSessions.set(threadId, session);

    // Save to database
    dbCreateSession({
      threadId,
      channelId,
      cliType,
      directory: workingDirectory,
      firstPrompt: prompt,
    });
    updateSessionStatus(threadId, 'active');
  } catch (error) {
    activeSessions.delete(threadId);
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function abortSession(threadId: string): Promise<boolean> {
  const session = activeSessions.get(threadId);
  if (session) {
    logger.log(`Aborting session for thread ${threadId}`);
    await session.abort();
    updateSessionStatus(threadId, 'aborted');
    return true;
  }

  return false;
}

export function isSessionActive(threadId: string): boolean {
  const session = activeSessions.get(threadId);
  return session?.isRunning() || false;
}

/** Placeholder for session reconnection on bot restart */
export async function reconnectSessions(): Promise<void> {
  logger.log('Session reconnection: agent servers persist independently');
}
