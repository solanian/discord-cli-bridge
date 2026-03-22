import WebSocket from 'ws';
import { createLogger } from '../logger.js';
import type { CLIAdapter, CLISession, SessionOptions, OutputChunk } from './base.js';

const logger = createLogger('CLAUDE-AGENT');

let nextRequestId = 1;

/**
 * Claude Agent SDK adapter via WebSocket.
 * Connects to a separately running claude-agent-server container.
 * Sessions persist via the SDK's session management.
 */
export class ClaudeAgentSession implements CLISession {
  private ws: WebSocket | null = null;
  private running = false;
  private threadId: string | undefined;
  private sessionId: string | undefined;
  private outputCallbacks: Array<(chunk: OutputChunk) => void> = [];
  private completeCallbacks: Array<(result: { sessionId?: string; durationMs?: number }) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private textBuffer = '';
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private options: SessionOptions) {}

  private get wsUrl(): string {
    return process.env['CLAUDE_AGENT_URL'] || 'ws://claude-agent:9877';
  }

  async start(): Promise<void> {
    logger.log(`Connecting to claude-agent-server at ${this.wsUrl}`);
    await this.connect();

    // Initialize
    await this.rpc('initialize', {});

    // Start session with prompt
    const result = await this.rpc('session/start', {
      cwd: this.options.workingDirectory,
      prompt: this.options.prompt,
      model: this.options.model,
      effort: this.options.effort,
      ...(this.options.sessionId && { sessionId: this.options.sessionId }),
    });
    this.threadId = result.threadId;
    logger.log(`Session started: threadId=${this.threadId}`);
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.running = true;
        logger.log('Connected to claude-agent-server');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {}
      });

      this.ws.on('close', () => {
        this.running = false;
        logger.log('Disconnected from claude-agent-server');
      });

      this.ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        if (!this.running) reject(error);
        for (const cb of this.errorCallbacks) cb(error as Error);
      });

      setTimeout(() => {
        if (!this.running) reject(new Error('Connection timeout'));
      }, 10000);
    });
  }

  async send(message: string): Promise<void> {
    if (!this.running) throw new Error('Session not running');

    // For follow-up messages, start a new session/start with resume
    await this.rpc('session/start', {
      cwd: this.options.workingDirectory,
      prompt: message,
      model: this.options.model,
      effort: this.options.effort,
      ...(this.sessionId && { sessionId: this.sessionId }),
    });
  }

  private rpc(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 120000);
    });
  }

  private handleMessage(msg: any): void {
    // RPC response
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notifications from server
    const method = msg.method;
    if (!method) return;

    switch (method) {
      case 'session/started': {
        this.sessionId = msg.params?.sessionId;
        logger.log(`Session ID: ${this.sessionId}`);
        break;
      }

      case 'assistant/text': {
        const text = msg.params?.text;
        if (text) {
          this.textBuffer += text;
          if (this.flushTimer) clearTimeout(this.flushTimer);
          if (this.textBuffer.length > 1500) {
            this.flushTextBuffer();
          } else {
            this.flushTimer = setTimeout(() => this.flushTextBuffer(), 3000);
          }
        }
        break;
      }

      case 'assistant/tool_use': {
        this.flushTextBuffer();
        const name = msg.params?.name || 'tool';
        this.emit({ type: 'tool_use', content: name, metadata: msg.params });
        break;
      }

      case 'session/completed': {
        this.flushTextBuffer();
        const elapsed = msg.params?.durationMs;
        logger.log(`Session completed (${elapsed}ms)`);
        for (const cb of this.completeCallbacks) {
          cb({ sessionId: this.sessionId, durationMs: elapsed });
        }
        break;
      }

      case 'session/error': {
        this.flushTextBuffer();
        const error = msg.params?.error || 'Unknown error';
        logger.error(`Session error: ${error}`);
        for (const cb of this.errorCallbacks) {
          cb(new Error(error));
        }
        break;
      }
    }
  }

  private flushTextBuffer(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.textBuffer.trim()) {
      this.emit({ type: 'text', content: this.textBuffer.trim() });
      this.textBuffer = '';
    }
  }

  private emit(chunk: OutputChunk): void {
    for (const cb of this.outputCallbacks) cb(chunk);
  }

  onOutput(callback: (chunk: OutputChunk) => void): void { this.outputCallbacks.push(callback); }
  onComplete(callback: (result: { sessionId?: string; durationMs?: number }) => void): void { this.completeCallbacks.push(callback); }
  onError(callback: (error: Error) => void): void { this.errorCallbacks.push(callback); }

  async abort(): Promise<void> {
    // SDK handles abort internally; closing connection stops processing
    this.flushTextBuffer();
  }

  async kill(): Promise<void> {
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.running = false;
  }

  isRunning(): boolean { return this.running; }
  getSessionId(): string | undefined { return this.sessionId; }
}

export class ClaudeAgentAdapter implements CLIAdapter {
  readonly name = 'claude' as const;

  async start(options: SessionOptions): Promise<CLISession> {
    const session = new ClaudeAgentSession(options);
    await session.start();
    return session;
  }

  async isAvailable(): Promise<boolean> {
    const url = (process.env['CLAUDE_AGENT_URL'] || 'ws://claude-agent:9877').replace('ws://', 'http://');
    try {
      const resp = await fetch(`${url.replace('9877', '9878')}/healthz`, { signal: AbortSignal.timeout(3000) });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
