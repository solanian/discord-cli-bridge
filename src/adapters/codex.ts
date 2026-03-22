import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import type { CLIAdapter, CLISession, SessionOptions, OutputChunk } from './base.js';

const logger = createLogger('CODEX');

interface CodexJsonEvent {
  type?: string;
  [key: string]: unknown;
}

class CodexSession implements CLISession {
  private process: ChildProcess | null = null;
  private running = false;
  private sessionId: string | undefined;
  private outputCallbacks: Array<(chunk: OutputChunk) => void> = [];
  private completeCallbacks: Array<(result: { sessionId?: string; durationMs?: number }) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private lineBuffer = '';
  private textBuffer = '';

  constructor(private options: SessionOptions) {
    this.sessionId = options.sessionId;
  }

  async start(): Promise<void> {
    const args = this.buildArgs();
    logger.log(`Starting: codex ${args.join(' ')}`);

    this.process = spawn('codex', args, {
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
      // Flush any remaining text buffer
      if (this.textBuffer.trim()) {
        this.emit({ type: 'text', content: this.textBuffer.trim() });
        this.textBuffer = '';
      }
      logger.log(`Process exited with code: ${code}`);
      for (const cb of this.completeCallbacks) {
        cb({ sessionId: this.sessionId });
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
    const args = ['exec'];

    if (this.options.sessionId) {
      args.push('resume', this.options.sessionId);
    }

    args.push('--json');
    // Fully autonomous: bypass all approvals and sandbox restrictions
    args.push('--dangerously-bypass-approvals-and-sandbox');
    // Allow running outside git repos
    args.push('--skip-git-repo-check');

    if (this.options.workingDirectory) {
      args.push('-C', this.options.workingDirectory);
    }

    if (this.options.model) {
      args.push('-m', this.options.model);
    }

    if (this.options.effort) {
      // Codex uses config override for reasoning effort
      args.push('-c', `model_reasoning_effort="${this.options.effort}"`);
    }

    args.push(this.options.prompt);

    return args;
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
    // Try to parse as JSON first (codex --json mode)
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line);
    } catch {
      // Not JSON - treat as plain text output
      this.emit({ type: 'text', content: line });
      return;
    }

    // Handle codex JSONL events
    // Actual codex --json output format:
    //   {"type":"thread.started","thread_id":"..."}
    //   {"type":"turn.started"}
    //   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    //   {"type":"item.completed","item":{"type":"function_call","name":"shell",...}}
    //   {"type":"item.completed","item":{"type":"function_call_output","output":"..."}}
    //   {"type":"turn.completed","usage":{...}}
    const eventType = event.type || '';

    switch (eventType) {
      case 'item.completed': {
        const item = (event as any).item;
        if (!item) break;

        if (item.type === 'agent_message' && item.text) {
          this.emit({ type: 'text', content: item.text });
        } else if (item.type === 'function_call') {
          this.emit({
            type: 'tool_use',
            content: item.name || 'tool',
            metadata: { name: item.name, arguments: item.arguments },
          });
        } else if (item.type === 'function_call_output') {
          this.emit({
            type: 'tool_result',
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
          });
        }
        break;
      }

      case 'message': {
        // Fallback for older codex versions
        const content = (event as any).content;
        if (typeof content === 'string') {
          this.emit({ type: 'text', content });
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'output_text' && part.text) {
              this.emit({ type: 'text', content: part.text });
            }
          }
        }
        break;
      }

      case 'error': {
        this.emit({
          type: 'error',
          content: (event as any).message || JSON.stringify(event),
        });
        break;
      }

      case 'thread.started':
      case 'turn.started':
      case 'turn.completed': {
        // Lifecycle events - no display needed
        logger.debug(`Codex: ${eventType}`);
        break;
      }

      default: {
        logger.debug(`Codex event: ${eventType} ${JSON.stringify(event).slice(0, 200)}`);
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
    throw new Error('Codex exec mode does not support stdin follow-up. Use resume instead.');
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
      logger.log('Aborting codex session');
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

export class CodexAdapter implements CLIAdapter {
  readonly name = 'codex' as const;

  async start(options: SessionOptions): Promise<CLISession> {
    const session = new CodexSession(options);
    await session.start();
    return session;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execFileSync('which', ['codex'], { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
