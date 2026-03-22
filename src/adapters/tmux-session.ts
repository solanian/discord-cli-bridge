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
const STABLE_COMPLETE = 4;
const STABLE_TIMEOUT = 100;

export function sessionName(threadId: string): string {
  return `${SESSION_PREFIX}${threadId}`;
}

// ─── Claude TUI parsing ────────────────────────────────────────────

const claudeParser = {
  /** Claude prompt: ❯ */
  isPromptLine(line: string): boolean {
    return line === '❯';
  },

  /** Claude user input: ❯ followed by text */
  isUserInput(line: string): boolean {
    return line.startsWith('❯ ') && line.length > 2;
  },

  /** Claude idle: ❯ alone near bottom */
  isIdlePrompt(lines: string[]): boolean {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      const l = lines[i]!.trim();
      if (!l) continue;
      if (l === '❯') return true;
      if (!claudeParser.isChrome(l)) return false;
    }
    return false;
  },

  isChrome(line: string): boolean {
    if (!line) return true;
    if (/^[─━╭╰│╮╯┃┣┫╌]+$/.test(line)) return true;
    if (line.startsWith('╭') || line.startsWith('╰') || line.startsWith('│')) return true;
    if (line.includes('bypass permissions on')) return true;
    if (line.includes('shift+tab to cycle')) return true;
    if (line.includes('· /effort')) return true;
    if (line.includes('Welcome back')) return true;
    if (line.includes('Claude Code v')) return true;
    if (line.includes('Tips for getting')) return true;
    if (line.includes('Recent activity')) return true;
    if (line.includes('No recent activity')) return true;
    if (line.includes('Claude Max')) return true;
    if (line.includes('Opus 4')) return true;
    if (line.includes('Sonnet')) return true;
    if (line.includes('▐▛') || line.includes('▝▜') || line.includes('▘▘')) return true;
    if (line.includes('/workspace/')) return true;
    if (line.includes('installMethod')) return true;
    if (line.includes('Claude Code has switched')) return true;
    if (line.includes('Double-tap esc')) return true;
    if (line.includes('ctrl+o to expand')) return true;
    if (line.includes('Tip:')) return true;
    if (line.includes('/permissions')) return true;
    if (line.includes('pre-approve')) return true;
    if (line.includes('pre-deny')) return true;
    // Spinners: ✻ Thinking…, ✽ Creating…, * Kneading…, etc
    if (/^[✻✽✶✢·✦✧✸*\-]\s/.test(line)) return true;
    if (/^[✻✽✶✢·✦✧✸*\-]?\s*\w+…$/.test(line)) return true;
    if (/^[✻✽✶✢·✦✧✸*\-]$/.test(line)) return true;
    if (line.includes('Reading') && line.includes('file')) return true;
    if (line.includes('Writing') && line.includes('memory')) return true;
    if (line.startsWith('⎿') && (line.includes('Tip:') || line.includes('$'))) return true;
    return false;
  },

  extractResponse(capture: string): string {
    const lines = capture.split('\n');
    let lastPromptIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i]!.trim();
      if (claudeParser.isUserInput(t)) { lastPromptIdx = i; break; }
    }
    if (lastPromptIdx === -1) return '';

    const out: string[] = [];
    for (let i = lastPromptIdx + 1; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (!t) continue;
      if (claudeParser.isPromptLine(t)) break;
      if (claudeParser.isChrome(t)) continue;
      out.push(t);
    }
    return out.join('\n').trim();
  },
};

// ─── Codex TUI parsing ─────────────────────────────────────────────

const codexParser = {
  isPromptLine(line: string): boolean {
    return line === '›' || line === '>';
  },

  isUserInput(line: string): boolean {
    if (!line.startsWith('› ') || line.length <= 2) return false;
    const text = line.slice(2);
    // Skip Codex TUI placeholder hints
    if (text.startsWith('Use /')) return false;
    if (text.startsWith('Summarize ')) return false;
    if (text.startsWith('Explain ')) return false;
    if (text.startsWith('Fix ')) return false;
    if (text.startsWith('Add ')) return false;
    if (text.startsWith('Write ')) return false;
    if (text.startsWith('Create ')) return false;
    if (text.startsWith('Refactor ')) return false;
    if (text.startsWith('Debug ')) return false;
    if (text.startsWith('Review ')) return false;
    if (text.startsWith('Test ')) return false;
    return true;
  },

  isIdlePrompt(lines: string[]): boolean {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      const l = lines[i]!.trim();
      if (!l) continue;
      if (l === '›' || l === '>') return true;
      // Codex shows placeholder hints like "› Explain this codebase", "› Use /skills"
      if (l.startsWith('›')) return true;
      if (!codexParser.isChrome(l)) return false;
    }
    return false;
  },

  isChrome(line: string): boolean {
    if (!line) return true;
    if (/^[─━╭╰│╮╯┃┣┫╌]+$/.test(line)) return true;
    if (line.startsWith('╭') || line.startsWith('╰') || line.startsWith('│')) return true;
    if (line.includes('OpenAI Codex')) return true;
    if (line.includes('/model to change')) return true;
    if (line.includes('left ·')) return true;
    if (line.includes('directory:')) return true;
    if (line.includes('model:')) return true;
    if (line.includes('bubblewrap')) return true;
    if (line.includes('bwrap')) return true;
    if (line.includes('composer is empty')) return true;
    if (line.includes('New 2x rate')) return true;
    if (line.includes('Summarize recent')) return true;
    if (line.startsWith('› Use /')) return true;
    if (line.startsWith('› Summarize')) return true;
    if (line.includes('press Esc to step back')) return true;
    if (line.includes('Enter confirms')) return true;
    // Codex spinners
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)) return true;
    // Working/thinking indicators: • Working (0s • esc to interrupt)
    if (line.includes('esc to interrupt')) return true;
    if (/^[•◦]\s*Working/.test(line)) return true;
    if (/^[•◦]\s*Thinking/.test(line)) return true;
    return false;
  },

  extractResponse(capture: string): string {
    const lines = capture.split('\n');
    let lastPromptIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i]!.trim();
      if (codexParser.isUserInput(t)) { lastPromptIdx = i; break; }
    }
    if (lastPromptIdx === -1) return '';

    const out: string[] = [];
    for (let i = lastPromptIdx + 1; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (!t) continue;
      // Any › line after response = idle prompt or placeholder hint = stop
      if (t.startsWith('›') || t === '>') break;
      if (codexParser.isChrome(t)) continue;
      out.push(t);
    }
    return out.join('\n').trim();
  },
};

// ─── TmuxCLISession ────────────────────────────────────────────────

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
  private parser: typeof claudeParser | typeof codexParser;

  constructor(
    private threadId: string,
    private cliType: 'claude' | 'codex',
    private options: SessionOptions,
  ) {
    this.name = sessionName(threadId);
    this.sessionId = threadId;
    this.parser = cliType === 'claude' ? claudeParser : codexParser;
  }

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

    await this.waitForPrompt();

    if (this.options.prompt) {
      await this.sendMessage(this.options.prompt);
    }
  }

  async reconnect(): Promise<void> {
    if (!await tmuxSessionExists(this.name)) {
      throw new Error(`tmux session ${this.name} does not exist`);
    }
    logger.log(`Reconnected to tmux session: ${this.name}`);
    this.running = true;
  }

  async send(message: string): Promise<void> {
    if (!this.running) throw new Error('Session not running');
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
      const parts = ['codex', '--dangerously-bypass-approvals-and-sandbox'];
      if (this.options.model) parts.push('-m', this.options.model);
      return parts.join(' ');
    }
  }

  private async waitForPrompt(): Promise<void> {
    logger.log(`Waiting for prompt in ${this.name}...`);
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      const capture = await tmuxCapturePaneAll(this.name).catch(() => '');
      const lines = capture.split('\n');

      if (this.parser.isIdlePrompt(lines)) {
        logger.log(`Prompt ready in ${this.name}`);
        return;
      }

      await tmuxSendKeys(this.name, '');
      logger.log(`Sent Enter to skip setup (attempt ${i + 1})`);
    }
    logger.warn(`Prompt not detected after 15s for ${this.name}, proceeding anyway`);
  }

  private async sendMessage(text: string): Promise<void> {
    logger.log(`Sending to ${this.name}: ${text.slice(0, 100)}`);
    this.lastCapture = await tmuxCapturePaneAll(this.name).catch(() => '');
    this.emittedContent = '';
    this.stableCount = 0;
    this.startTime = Date.now();
    this.waitingForResponse = true;

    await tmuxSendKeys(this.name, text);

    // Codex requires a second Enter to submit the message
    if (this.cliType === 'codex') {
      await sleep(300);
      await tmuxSendKeys(this.name, '');
    }

    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
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
          if (this.parser.isIdlePrompt(capture.split('\n'))) {
            // Only finish if there's actually a response to show
            const response = this.parser.extractResponse(capture);
            if (response) {
              this.finishResponse(capture);
              return;
            }
          }
        }
        if (this.waitingForResponse && this.stableCount >= STABLE_TIMEOUT) {
          logger.warn(`Timeout for ${this.name}`);
          this.finishResponse(capture);
          return;
        }
        return;
      }

      this.stableCount = 0;
      this.lastCapture = capture;

      const newContent = this.extractNewContent(capture);
      if (newContent) {
        this.emit({ type: 'text', content: newContent });
      }
    } catch (error) {
      logger.error(`Poll error for ${this.name}:`, error);
    }
  }

  private extractNewContent(capture: string): string {
    const response = this.parser.extractResponse(capture);
    if (!response) return '';
    if (response === this.emittedContent) return '';

    if (this.emittedContent && response.startsWith(this.emittedContent)) {
      const newPart = response.slice(this.emittedContent.length).trim();
      this.emittedContent = response;
      return newPart;
    }

    this.emittedContent = response;
    return response;
  }

  private finishResponse(capture: string): void {
    this.stopPolling();
    this.waitingForResponse = false;

    const finalContent = this.extractNewContent(capture);
    if (finalContent) {
      this.emit({ type: 'text', content: finalContent });
    }

    const elapsed = Date.now() - this.startTime;
    logger.log(`Response complete for ${this.name} (${elapsed}ms)`);

    for (const cb of this.completeCallbacks) {
      cb({ sessionId: this.sessionId, durationMs: elapsed });
    }
  }

  private emit(chunk: OutputChunk): void {
    for (const cb of this.outputCallbacks) cb(chunk);
  }

  onOutput(callback: (chunk: OutputChunk) => void): void { this.outputCallbacks.push(callback); }
  onComplete(callback: (result: { sessionId?: string; durationMs?: number }) => void): void { this.completeCallbacks.push(callback); }
  onError(callback: (error: Error) => void): void { this.errorCallbacks.push(callback); }

  async abort(): Promise<void> {
    this.stopPolling();
    this.waitingForResponse = false;
    await tmuxSendControlC(this.name);
  }

  async kill(): Promise<void> {
    this.stopPolling();
    this.running = false;
    this.waitingForResponse = false;
    await tmuxKillSession(this.name);
  }

  isRunning(): boolean { return this.running; }
  getSessionId(): string | undefined { return this.sessionId; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
