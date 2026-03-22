import type { CLIType } from '../config.js';

export interface SessionOptions {
  prompt: string;
  workingDirectory: string;
  sessionId?: string;     // resume existing session
  model?: string;         // override model
  maxContext?: number;     // max context window tokens
  effort?: string;        // thinking effort level (claude: low/medium/high/max, codex: low/medium/high)
  maxBudgetUsd?: number;  // max dollar budget per session (claude only)
}

export interface OutputChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system' | 'result';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CLISession {
  send(message: string): Promise<void>;
  onOutput(callback: (chunk: OutputChunk) => void): void;
  onComplete(callback: (result: { sessionId?: string; durationMs?: number }) => void): void;
  onError(callback: (error: Error) => void): void;
  abort(): Promise<void>;
  isRunning(): boolean;
  getSessionId(): string | undefined;
}

export interface CLIAdapter {
  readonly name: CLIType;
  start(options: SessionOptions): Promise<CLISession>;
  isAvailable(): Promise<boolean>;
}
