import { createLogger } from '../logger.js';
import type { CLISession, SessionOptions, OutputChunk } from './base.js';
import {
  tmuxSessionExists,
  tmuxCreateSession,
  tmuxCapturePaneAll,
  tmuxKillSession,
} from './tmux-utils.js';
import {
  appendMessage,
  getMessages,
} from '../database.js';

const logger = createLogger('TMUX-SESSION');
const SESSION_PREFIX = 'dcb-';

export function sessionName(threadId: string): string {
  return `${SESSION_PREFIX}${threadId}`;
}

/**
 * Hybrid approach: uses `claude -p` (one-shot) for reliability,
 * but stores conversation history in DB and includes it in each prompt.
 *
 * tmux is used to run the subprocess so it survives bot restarts.
 * The capture-pane polling detects when the response is complete.
 */
export class TmuxCLISession implements CLISession {
  private name: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastCapture = '';
  private stableCount = 0;
  private running = false;
  private sessionId: string | undefined;
  private outputCallbacks: Array<(chunk: OutputChunk) => void> = [];
  private completeCallbacks: Array<(result: { sessionId?: string; durationMs?: number }) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private startTime = 0;
  private emittedContent = '';

  constructor(
    private threadId: string,
    private cliType: 'claude' | 'codex',
    private options: SessionOptions,
  ) {
    this.name = sessionName(threadId);
    this.sessionId = threadId;
  }

  async start(): Promise<void> {
    await this.runPrompt(this.options.prompt);
  }

  async reconnect(): Promise<void> {
    // For DB-based history, reconnect just means we're ready
    this.running = true;
    logger.log(`Session ${this.name} ready for reconnect`);
  }

  async send(message: string): Promise<void> {
    await this.runPrompt(message);
  }

  private async runPrompt(userMessage: string): Promise<void> {
    // Kill any existing tmux session for this thread
    if (await tmuxSessionExists(this.name)) {
      await tmuxKillSession(this.name);
      await sleep(500);
    }

    // Build prompt with conversation history
    const history = getMessages(this.threadId, 30);
    let fullPrompt: string;

    if (history.length > 0) {
      const historyText = history.map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      ).join('\n\n');
      fullPrompt = `Here is our conversation so far:\n\n${historyText}\n\nUser: ${userMessage}\n\nContinue the conversation. Respond to the latest user message.`;
    } else {
      fullPrompt = userMessage;
    }

    // Save user message to DB
    appendMessage(this.threadId, 'user', userMessage);

    // Build CLI command
    const cmd = this.buildCommand(fullPrompt);
    logger.log(`Running in tmux ${this.name}: ${cmd.slice(0, 120)}...`);

    this.startTime = Date.now();
    this.emittedContent = '';
    this.stableCount = 0;
    this.running = true;

    // Create tmux session running claude -p
    await tmuxCreateSession(this.name, cmd, this.options.workingDirectory);

    // Start polling for output
    await sleep(1000);
    this.lastCapture = await tmuxCapturePaneAll(this.name).catch(() => '');
    this.startPolling();
  }

  private buildCommand(prompt: string): string {
    // Escape the prompt for shell
    const escaped = prompt.replace(/'/g, "'\\''");

    if (this.cliType === 'claude') {
      const parts = [
        'claude', '-p',
        '--output-format', 'text',
        '--dangerously-skip-permissions',
      ];
      if (this.options.model) parts.push('--model', this.options.model);
      if (this.options.effort) parts.push('--effort', this.options.effort);
      if (this.options.maxBudgetUsd) parts.push('--max-budget-usd', String(this.options.maxBudgetUsd));
      parts.push(`'${escaped}'`);
      // Keep the session alive after command finishes so we can capture output
      return `${parts.join(' ')}; echo "___DCB_DONE___"; sleep 86400`;
    } else {
      const parts = [
        'codex', 'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
      ];
      if (this.options.model) parts.push('-m', this.options.model);
      if (this.options.effort) parts.push('-c', `model_reasoning_effort="${this.options.effort}"`);
      parts.push(`'${escaped}'`);
      return `${parts.join(' ')}; echo "___DCB_DONE___"; sleep 86400`;
    }
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.poll(), 800);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const capture = await tmuxCapturePaneAll(this.name);

      if (capture === this.lastCapture) {
        this.stableCount++;
        // If stable and we see our done marker, response is complete
        if (this.stableCount >= 3 && capture.includes('___DCB_DONE___')) {
          this.finishResponse(capture);
          return;
        }
        // Timeout fallback (60 seconds of no change)
        if (this.stableCount >= 75) {
          logger.warn(`Timeout for ${this.name}`);
          this.finishResponse(capture);
          return;
        }
        return;
      }

      // Content changed
      this.stableCount = 0;

      // Check for done marker
      if (capture.includes('___DCB_DONE___')) {
        // Wait a bit for final content
        this.lastCapture = capture;
        return; // Will be caught by stability check above
      }

      // Emit new content
      const newContent = this.extractNewContent(capture);
      if (newContent) {
        this.emit({ type: 'text', content: newContent });
      }

      this.lastCapture = capture;
    } catch (error) {
      logger.error(`Poll error for ${this.name}:`, error);
    }
  }

  private extractNewContent(capture: string): string {
    // Remove the done marker and everything after
    const clean = (capture.split('___DCB_DONE___')[0] || capture).trim();

    if (!clean) return '';

    // If we have previous emitted content, only return what's new
    if (this.emittedContent) {
      if (clean.length > this.emittedContent.length) {
        const newPart = clean.slice(this.emittedContent.length).trim();
        this.emittedContent = clean;
        return newPart;
      }
      // Content same or shorter (redraw) - nothing new
      return '';
    }

    // First time - emit everything
    this.emittedContent = clean;
    return clean;
  }

  private finishResponse(capture: string): void {
    this.stopPolling();

    // Extract final response
    const finalContent = this.extractNewContent(capture);
    if (finalContent) {
      this.emit({ type: 'text', content: finalContent });
    }

    // Save full response to DB
    const fullResponse = (capture.split('___DCB_DONE___')[0] || '').trim();
    if (fullResponse) {
      appendMessage(this.threadId, 'assistant', fullResponse);
    }

    // Kill the tmux session (it was just sleeping)
    tmuxKillSession(this.name).catch(() => {});

    const elapsed = Date.now() - this.startTime;
    logger.log(`Response complete for ${this.name} (${elapsed}ms)`);

    for (const cb of this.completeCallbacks) {
      cb({ sessionId: this.sessionId, durationMs: elapsed });
    }
  }

  private emit(chunk: OutputChunk): void {
    for (const cb of this.outputCallbacks) cb(chunk);
  }

  onOutput(callback: (chunk: OutputChunk) => void): void {
    this.outputCallbacks.push(callback);
  }

  onComplete(callback: (result: { sessionId?: string; durationMs?: number }) => void): void {
    this.completeCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  async abort(): Promise<void> {
    this.stopPolling();
    await tmuxKillSession(this.name).catch(() => {});
  }

  async kill(): Promise<void> {
    await this.abort();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
