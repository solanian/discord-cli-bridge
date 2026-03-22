import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import type { CLIAdapter, CLISession, SessionOptions, OutputChunk } from './base.js';

const logger = createLogger('CLAUDE');

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    [key: string]: unknown;
  };
  result?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

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
  }

  private buildArgs(): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    if (this.options.sessionId) {
      args.push('-r', this.options.sessionId);
    }

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Note: permission bypass relies on ~/.claude/settings.json "defaultMode": "dontAsk"
    // --dangerously-skip-permissions is blocked when running as root in Docker

    if (this.options.effort) {
      args.push('--effort', this.options.effort);
    }

    if (this.options.maxBudgetUsd) {
      args.push('--max-budget-usd', this.options.maxBudgetUsd.toString());
    }

    args.push(this.options.prompt);

    return args;
  }

  private handleStdout(data: string): void {
    this.lineBuffer += data;
    const lines = this.lineBuffer.split('\n');
    // Keep last incomplete line in buffer
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

  async send(_message: string): Promise<void> {
    // Claude Code in -p mode doesn't support follow-up messages via stdin.
    // A new process needs to be started with --resume.
    throw new Error('Claude Code -p mode does not support stdin follow-up. Use resume instead.');
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
      // Give it a moment, then force kill
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
