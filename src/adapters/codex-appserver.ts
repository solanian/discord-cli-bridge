import WebSocket from 'ws';
import { createLogger } from '../logger.js';
import type { CLIAdapter, CLISession, SessionOptions, OutputChunk } from './base.js';

const logger = createLogger('CODEX-APP');

let nextRequestId = 1;

/**
 * Codex app-server adapter via WebSocket.
 * Connects to a separately running `codex app-server --listen ws://host:port`.
 * Sessions persist as long as the app-server process is alive.
 */
export class CodexAppServerSession implements CLISession {
  private ws: WebSocket | null = null;
  private running = false;
  private threadId: string | undefined;
  private outputCallbacks: Array<(chunk: OutputChunk) => void> = [];
  private completeCallbacks: Array<(result: { sessionId?: string; durationMs?: number }) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private startTime = 0;
  private textBuffer = '';
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private options: SessionOptions) {}

  private get wsUrl(): string {
    return process.env['CODEX_APPSERVER_URL'] || 'ws://codex-appserver:9876';
  }

  async start(): Promise<void> {
    logger.log(`Connecting to codex app-server at ${this.wsUrl}`);

    await this.connect();

    // Initialize
    await this.rpc('initialize', {
      clientInfo: { name: 'discord-cli-bridge', version: '0.1.0' },
      capabilities: {},
    });

    // Start thread
    const threadResult = await this.rpc('thread/start', {
      cwd: this.options.workingDirectory,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(this.options.model && { model: this.options.model }),
    });
    this.threadId = threadResult.thread?.id;
    logger.log(`Thread started: ${this.threadId}`);

    if (this.options.prompt) {
      await this.sendTurn(this.options.prompt);
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.running = true;
        logger.log('Connected to codex app-server');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleData(data.toString());
      });

      this.ws.on('close', () => {
        this.running = false;
        logger.log('Disconnected from codex app-server');
      });

      this.ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        if (!this.running) reject(error);
        for (const cb of this.errorCallbacks) cb(error as Error);
      });

      setTimeout(() => {
        if (!this.running) reject(new Error('WebSocket connection timeout'));
      }, 10000);
    });
  }

  async send(message: string): Promise<void> {
    if (!this.running || !this.threadId) {
      throw new Error('Session not running');
    }
    await this.sendTurn(message);
  }

  private async sendTurn(text: string): Promise<void> {
    this.startTime = Date.now();
    logger.log(`Sending turn: ${text.slice(0, 100)}`);
    await this.rpc('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text }],
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
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 60000);
    });
  }

  private handleData(data: string): void {
    // WebSocket messages are complete JSON objects (not line-delimited)
    try {
      const msg = JSON.parse(data);
      this.handleMessage(msg);
    } catch {
      logger.debug(`Non-JSON message: ${data.slice(0, 100)}`);
    }
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

    const method = msg.method;
    if (!method) return;

    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = msg.params?.delta;
        if (delta) {
          this.textBuffer += delta;
          if (this.flushTimer) clearTimeout(this.flushTimer);
          if (this.textBuffer.length > 1500) {
            this.flushTextBuffer();
          } else {
            this.flushTimer = setTimeout(() => this.flushTextBuffer(), 3000);
          }
        }
        break;
      }

      case 'item/completed': {
        const item = msg.params?.item;
        if (!item) break;

        if (item.type === 'agentMessage' && item.text) {
          if (this.textBuffer) this.flushTextBuffer();
        } else if (item.type === 'function_call' || item.type === 'localShellInvocation') {
          this.flushTextBuffer();
          const name = item.name || item.callId || 'tool';
          this.emit({ type: 'tool_use', content: name, metadata: item });
        } else if (item.type === 'function_call_output' || item.type === 'localShellOutput') {
          const output = item.output || '';
          this.emit({ type: 'tool_result', content: typeof output === 'string' ? output.slice(0, 500) : '' });
        }
        break;
      }

      case 'turn/completed': {
        this.flushTextBuffer();
        const elapsed = Date.now() - this.startTime;
        logger.log(`Turn completed (${elapsed}ms)`);
        for (const cb of this.completeCallbacks) {
          cb({ sessionId: this.threadId, durationMs: elapsed });
        }
        break;
      }

      case 'account/rateLimits/updated': {
        const limits = msg.params?.rateLimits;
        if (limits?.primary) {
          logger.log(`Rate limit: ${limits.primary.usedPercent}% used`);
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
    if (this.threadId && this.running) {
      try {
        await this.rpc('turn/interrupt', { threadId: this.threadId });
      } catch {}
    }
  }

  async kill(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.running = false;
  }

  isRunning(): boolean { return this.running; }
  getSessionId(): string | undefined { return this.threadId; }
}

export class CodexAppServerAdapter implements CLIAdapter {
  readonly name = 'codex' as const;

  async start(options: SessionOptions): Promise<CLISession> {
    const session = new CodexAppServerSession(options);
    await session.start();
    return session;
  }

  async isAvailable(): Promise<boolean> {
    // Check if app-server is reachable
    const url = (process.env['CODEX_APPSERVER_URL'] || 'ws://codex-appserver:9876').replace('ws://', 'http://');
    try {
      const resp = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
