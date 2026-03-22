import { createLogger } from '../logger.js';
import type { CLISession, SessionOptions, OutputChunk } from './base.js';
import {
  tmuxSessionExists,
  tmuxCreateSession,
  tmuxSendKeys,
  tmuxSendControlC,
  tmuxCapturePaneAll,
  tmuxKillSession,
} from './tmux-utils.js';

const logger = createLogger('TMUX-SESSION');
const SESSION_PREFIX = 'dcb-';
const POLL_INTERVAL_MS = 600;
const STABLE_COMPLETE = 4;   // 2.4s stable + prompt = response done
const STABLE_TIMEOUT = 100;  // 60s fallback

// Claude interactive mode prompt
const PROMPT_RE = /❯\s*$/;

export function sessionName(threadId: string): string {
  return `${SESSION_PREFIX}${threadId}`;
}

/**
 * Persistent tmux session running claude/codex in interactive mode.
 * The CLI process stays alive across messages — context is naturally preserved.
 * Messages are injected via tmux send-keys, output captured via capture-pane polling.
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
  private waitingForResponse = false;

  constructor(
    private threadId: string,
    private cliType: 'claude' | 'codex',
    private options: SessionOptions,
  ) {
    this.name = sessionName(threadId);
    this.sessionId = threadId;
  }

  /** Create a new tmux session with the CLI, run onboarding, then send prompt */
  async start(): Promise<void> {
    const exists = await tmuxSessionExists(this.name);

    if (exists) {
      logger.log(`Reusing existing tmux session: ${this.name}`);
      this.running = true;
      await this.sendMessage(this.options.prompt);
      return;
    }

    const cmd = this.buildCommand();
    logger.log(`Creating tmux session: ${this.name} → ${cmd}`);
    await tmuxCreateSession(this.name, cmd, this.options.workingDirectory);
    this.running = true;

    // Wait for CLI to start and skip onboarding screens
    await this.waitForPrompt();

    // Send initial prompt
    if (this.options.prompt) {
      await this.sendMessage(this.options.prompt);
    }
  }

  /** Reconnect to an existing tmux session (after bot restart) */
  async reconnect(): Promise<void> {
    if (!await tmuxSessionExists(this.name)) {
      throw new Error(`tmux session ${this.name} does not exist`);
    }
    logger.log(`Reconnected to tmux session: ${this.name}`);
    this.running = true;
  }

  /** Send a follow-up message — context preserved because process is alive */
  async send(message: string): Promise<void> {
    if (!this.running) throw new Error('Session not running');

    // If tmux session died, throw so session-manager can recreate
    if (!await tmuxSessionExists(this.name)) {
      this.running = false;
      throw new Error('tmux session no longer exists');
    }

    await this.sendMessage(message);
  }

  private buildCommand(): string {
    if (this.cliType === 'claude') {
      const parts = ['claude', '--dangerously-skip-permissions'];
      if (this.options.model) parts.push('--model', this.options.model);
      if (this.options.effort) parts.push('--effort', this.options.effort);
      return parts.join(' ');
    } else {
      const parts = ['codex', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];
      if (this.options.model) parts.push('-m', this.options.model);
      return parts.join(' ');
    }
  }

  /** Skip setup screens (trust folder, etc.) by pressing Enter until we see the ❯ prompt */
  private async waitForPrompt(): Promise<void> {
    logger.log(`Waiting for prompt in ${this.name}...`);
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      const capture = await tmuxCapturePaneAll(this.name).catch(() => '');

      if (PROMPT_RE.test(capture.trim())) {
        logger.log(`Prompt ready in ${this.name}`);
        return;
      }

      // Press Enter to skip trust/setup screens
      await tmuxSendKeys(this.name, '');
      logger.log(`Sent Enter to skip setup (attempt ${i + 1})`);
    }
    logger.warn(`Prompt not detected after 15s for ${this.name}, proceeding anyway`);
  }

  private async sendMessage(text: string): Promise<void> {
    logger.log(`Sending to ${this.name}: ${text.slice(0, 100)}`);

    // Capture baseline before sending
    this.lastCapture = await tmuxCapturePaneAll(this.name).catch(() => '');
    this.emittedContent = this.lastCapture;
    this.stableCount = 0;
    this.startTime = Date.now();
    this.waitingForResponse = true;

    // Send via tmux send-keys
    await tmuxSendKeys(this.name, text);

    // Start polling for response
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      if (!await tmuxSessionExists(this.name)) {
        this.running = false;
        this.stopPolling();
        for (const cb of this.errorCallbacks) cb(new Error('tmux session terminated'));
        return;
      }

      const capture = await tmuxCapturePaneAll(this.name);

      if (capture === this.lastCapture) {
        this.stableCount++;

        if (this.waitingForResponse && this.stableCount >= STABLE_COMPLETE) {
          // Check if CLI is back at prompt (response finished)
          if (this.isAtPrompt(capture)) {
            this.finishResponse(capture);
            return;
          }
        }

        if (this.waitingForResponse && this.stableCount >= STABLE_TIMEOUT) {
          logger.warn(`Timeout for ${this.name}`);
          this.finishResponse(capture);
          return;
        }
        return;
      }

      // New content
      this.stableCount = 0;
      this.lastCapture = capture;

      // Extract and emit new content
      const newContent = this.extractNewContent(capture);
      if (newContent) {
        this.emit({ type: 'text', content: newContent });
      }
    } catch (error) {
      logger.error(`Poll error for ${this.name}:`, error);
    }
  }

  private isAtPrompt(capture: string): boolean {
    const trimmed = capture.trim();
    // Last line should be the prompt character
    const lastLine = trimmed.split('\n').pop()?.trim() || '';
    return PROMPT_RE.test(lastLine) || lastLine === '❯' || lastLine === '>';
  }

  private extractNewContent(capture: string): string {
    if (!this.emittedContent) {
      this.emittedContent = capture;
      return '';
    }

    // Find new content by comparing with what we already emitted
    if (capture.length > this.emittedContent.length &&
        capture.startsWith(this.emittedContent.slice(0, 200))) {
      const raw = capture.slice(this.emittedContent.length);
      this.emittedContent = capture;
      return this.cleanForDiscord(raw);
    }

    // Content changed significantly (scroll/redraw)
    // Compare line by line from the end
    const oldLines = this.emittedContent.split('\n');
    const newLines = capture.split('\n');

    if (newLines.length > oldLines.length) {
      const diff = newLines.slice(oldLines.length);
      this.emittedContent = capture;
      return this.cleanForDiscord(diff.join('\n'));
    }

    this.emittedContent = capture;
    return '';
  }

  private cleanForDiscord(raw: string): string {
    return raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => {
        if (!l) return false;
        if (PROMPT_RE.test(l) || l === '❯' || l === '>') return false;
        // Filter TUI chrome
        if (/^[─━╭╰│╮╯┃┣┫]+$/.test(l)) return false;
        if (l.includes('bypass permissions on')) return false;
        if (l.includes('shift+tab to cycle')) return false;
        return true;
      })
      .join('\n')
      .trim();
  }

  private finishResponse(capture: string): void {
    this.stopPolling();
    this.waitingForResponse = false;

    // Emit any remaining content
    const finalContent = this.extractNewContent(capture);
    if (finalContent) {
      this.emit({ type: 'text', content: finalContent });
    }

    const elapsed = Date.now() - this.startTime;
    logger.log(`Response complete for ${this.name} (${elapsed}ms)`);

    for (const cb of this.completeCallbacks) {
      cb({ sessionId: this.sessionId, durationMs: elapsed });
    }
    // Session stays alive for next message
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

  /** Interrupt current operation (Ctrl-C), but keep session alive */
  async abort(): Promise<void> {
    this.stopPolling();
    this.waitingForResponse = false;
    await tmuxSendControlC(this.name);
  }

  /** Kill the tmux session entirely */
  async kill(): Promise<void> {
    this.stopPolling();
    this.running = false;
    this.waitingForResponse = false;
    await tmuxKillSession(this.name);
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
