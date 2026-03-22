import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import type { CLIAdapter, CLISession, SessionOptions, OutputChunk } from './base.js';

const logger = createLogger('CLAUDE');

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    [key: string]: unknown;
  };
  result?: string;
  duration_ms?: number;
  errors?: string[];
  [key: string]: unknown;
}

/**
 * Persistent Claude Code session using bidirectional stream-json.
 *
 * Instead of spawning a new process per message (-p one-shot mode),
 * this keeps a single process alive with:
 *   --input-format stream-json --output-format stream-json
 *
 * User messages are sent via stdin as JSON, responses come on stdout.
 * Context is preserved because the process stays alive.
 */
class ClaudeCodeSession implements CLISession {
  private process: ChildProcess | null = null;
  private running = false;
  private sessionId: string | undefined;
  private outputCallbacks: Array<(chunk: OutputChunk) => void> = [];
  private completeCallbacks: Array<(result: { sessionId?: string; durationMs?: number }) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private lineBuffer = '';

  constructor(private options: SessionOptions) {
    this.sessionId = options.sessionId;
  }

  async start(): Promise<void> {
    const args = this.buildArgs();
    logger.log(`Starting: claude ${args.join(' ')}`);

    this.process = spawn('claude', args, {
      cwd: this.options.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.running = true;

    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data.toString());
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        logger.debug(`stderr: ${text}`);
      }
    });

    this.process.on('close', (code) => {
      this.running = false;
      if (this.lineBuffer.trim()) {
        this.parseLine(this.lineBuffer.trim());
        this.lineBuffer = '';
      }
      logger.log(`Process exited with code: ${code}`);
      for (const cb of this.completeCallbacks) {
        cb({ sessionId: this.sessionId, durationMs: undefined });
      }
    });

    this.process.on('error', (error) => {
      this.running = false;
      logger.error('Process error:', error);
      for (const cb of this.errorCallbacks) {
        cb(error);
      }
    });

    // Send the initial prompt via stdin
    this.writeUserMessage(this.options.prompt);
  }

  private buildArgs(): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Fully autonomous: bypass all permission checks
    args.push('--dangerously-skip-permissions');

    if (this.options.effort) {
      args.push('--effort', this.options.effort);
    }

    if (this.options.maxBudgetUsd) {
      args.push('--max-budget-usd', this.options.maxBudgetUsd.toString());
    }

    return args;
  }

  /**
   * Send a user message via stdin in stream-json format.
   */
  private writeUserMessage(text: string): void {
    if (!this.process?.stdin?.writable) {
      logger.error('Cannot write: stdin not writable');
      return;
    }
    const msg = JSON.stringify({ type: 'user_message', content: text });
    this.process.stdin.write(msg + '\n');
    logger.log(`Sent user message: ${text.slice(0, 80)}`);
  }

  /**
   * Send a follow-up message to the running session.
   * Context is preserved because the process stays alive.
   */
  async send(message: string): Promise<void> {
    if (!this.running) {
      throw new Error('Session is not running');
    }
    this.writeUserMessage(message);
  }

  private handleStdout(data: string): void {
    this.lineBuffer += data;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  private parseLine(line: string): void {
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      logger.debug(`Non-JSON line: ${line.slice(0, 200)}`);
      return;
    }

    switch (event.type) {
      case 'system': {
        if (event.subtype === 'init' && event.session_id) {
          this.sessionId = event.session_id;
          this.emit({ type: 'system', content: `Session: ${event.session_id}` });
        }
        break;
      }

      case 'assistant': {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text) {
              this.emit({ type: 'text', content: part.text });
            } else if (part.type === 'tool_use') {
              this.emit({
                type: 'tool_use',
                content: `${part.name || 'tool'}`,
                metadata: { name: part.name, input: part.input },
              });
            } else if (part.type === 'tool_result') {
              this.emit({
                type: 'tool_result',
                content: typeof part.text === 'string' ? part.text : JSON.stringify(part),
              });
            }
          }
        }
        break;
      }

      case 'result': {
        if (event.subtype === 'error_during_execution' || event.is_error) {
          const errors = event.errors;
          const errMsg = Array.isArray(errors) ? errors.join('; ') : (event.result || 'Unknown error');
          this.emit({ type: 'error', content: errMsg });
          break;
        }
        const resultText = event.result || '';
        this.emit({
          type: 'result',
          content: resultText,
          metadata: {
            duration_ms: event.duration_ms,
            session_id: event.session_id,
            subtype: event.subtype,
          },
        });
        break;
      }
    }
  }

  private emit(chunk: OutputChunk): void {
    for (const cb of this.outputCallbacks) {
      cb(chunk);
    }
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
    if (this.process && !this.process.killed) {
      logger.log('Aborting claude session');
      this.process.kill('SIGINT');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }
}

export class ClaudeCodeAdapter implements CLIAdapter {
  readonly name = 'claude' as const;

  async start(options: SessionOptions): Promise<CLISession> {
    const session = new ClaudeCodeSession(options);
    await session.start();
    return session;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execFileSync('which', ['claude'], { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
