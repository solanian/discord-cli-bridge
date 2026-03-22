import fs from 'node:fs';
import path from 'node:path';
import { getLogFilePath } from './config.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let logStream: fs.WriteStream | null = null;
let currentLogLevel = LogLevel.INFO;

function getLogStream(): fs.WriteStream | null {
  if (!logStream) {
    try {
      const logPath = getLogFilePath();
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      logStream = fs.createWriteStream(logPath, { flags: 'a' });
      logStream.on('error', () => {}); // Ignore write errors
    } catch {
      return null;
    }
  }
  return logStream;
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: string, prefix: string, ...args: unknown[]): string {
  const msg = args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }).join(' ');
  return `${timestamp()} [${level}] [${prefix}] ${msg}`;
}

export function createLogger(prefix: string) {
  return {
    debug(...args: unknown[]) {
      if (currentLogLevel > LogLevel.DEBUG) return;
      const msg = formatMessage('DEBUG', prefix, ...args);
      getLogStream()?.write(msg + '\n');
    },
    log(...args: unknown[]) {
      const msg = formatMessage('INFO', prefix, ...args);
      console.log(`[${prefix}]`, ...args);
      getLogStream()?.write(msg + '\n');
    },
    warn(...args: unknown[]) {
      const msg = formatMessage('WARN', prefix, ...args);
      console.warn(`[${prefix}]`, ...args);
      getLogStream()?.write(msg + '\n');
    },
    error(...args: unknown[]) {
      const msg = formatMessage('ERROR', prefix, ...args);
      console.error(`[${prefix}]`, ...args);
      getLogStream()?.write(msg + '\n');
    },
  };
}

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
