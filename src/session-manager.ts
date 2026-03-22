import { createLogger } from './logger.js';
import { TmuxCLISession, sessionName } from './adapters/tmux-session.js';
import { CodexAppServerSession } from './adapters/codex-appserver.js';
import { tmuxListSessions, tmuxSessionExists, isTmuxAvailable } from './adapters/tmux-utils.js';
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
      // Codex: use app-server (JSON-RPC, proper streaming, no TUI parsing)
      const codexSession = new CodexAppServerSession({ prompt, workingDirectory, model, effort, maxBudgetUsd });
      codexSession.onOutput(onOutput);
      codexSession.onComplete((result) => {
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
      // Claude: use tmux (interactive mode with send-keys)
      const tmuxName = sessionName(threadId);
      const tmuxExists = await tmuxSessionExists(tmuxName);

      const tmuxSession = new TmuxCLISession(threadId, cliType, {
        prompt, workingDirectory, model, effort, maxBudgetUsd,
      });
      tmuxSession.onOutput(onOutput);
      tmuxSession.onComplete((result) => {
        updateSessionStatus(threadId, 'idle');
        onComplete(result);
      });
      tmuxSession.onError((error) => {
        updateSessionStatus(threadId, 'error');
        onError(error);
      });

      if (tmuxExists) {
        await tmuxSession.reconnect();
        await tmuxSession.send(prompt);
      } else {
        await tmuxSession.start();
      }
      session = tmuxSession;
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

  // Try killing the tmux session directly
  const tmuxName = sessionName(threadId);
  if (await tmuxSessionExists(tmuxName)) {
    const s = new TmuxCLISession(threadId, 'claude', { prompt: '', workingDirectory: '/' });
    await s.kill();
    activeSessions.delete(threadId);
    updateSessionStatus(threadId, 'aborted');
    return true;
  }

  return false;
}

export function isSessionActive(threadId: string): boolean {
  const session = activeSessions.get(threadId);
  return session?.isRunning() || false;
}

/** Reconnect to surviving tmux sessions after bot restart */
export async function reconnectTmuxSessions(): Promise<void> {
  if (!await isTmuxAvailable()) {
    logger.warn('tmux not available, skipping reconnection');
    return;
  }

  const sessions = await tmuxListSessions(SESSION_PREFIX);
  if (sessions.length === 0) {
    logger.log('No existing tmux sessions to reconnect');
    return;
  }

  logger.log(`Found ${sessions.length} existing tmux session(s) to reconnect`);
  for (const name of sessions) {
    const threadId = name.replace(SESSION_PREFIX, '');
    const dbSession = getSession(threadId);
    if (!dbSession) {
      logger.warn(`No DB record for tmux session ${name}, skipping`);
      continue;
    }

    try {
      const session = new TmuxCLISession(threadId, dbSession.cli_type, {
        prompt: '',
        workingDirectory: dbSession.directory,
      });
      await session.reconnect();
      activeSessions.set(threadId, session);
      logger.log(`Reconnected to tmux session ${name}`);
    } catch (error) {
      logger.error(`Failed to reconnect to ${name}:`, error);
    }
  }
}
