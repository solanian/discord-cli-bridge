import { describe, it, expect, afterEach } from 'vitest';
import { getDefaultCLI, getDataDir } from '../src/config.js';

describe('config', () => {
  afterEach(() => {
    delete process.env['BOT_CLI_TYPE'];
    delete process.env['DEFAULT_CLI'];
  });

  it('should default to claude', () => {
    expect(getDefaultCLI()).toBe('claude');
  });

  it('should respect BOT_CLI_TYPE env', () => {
    process.env['BOT_CLI_TYPE'] = 'codex';
    expect(getDefaultCLI()).toBe('codex');
  });

  it('should fall back to DEFAULT_CLI env', () => {
    process.env['DEFAULT_CLI'] = 'codex';
    expect(getDefaultCLI()).toBe('codex');
  });

  it('should prioritize BOT_CLI_TYPE over DEFAULT_CLI', () => {
    process.env['BOT_CLI_TYPE'] = 'claude';
    process.env['DEFAULT_CLI'] = 'codex';
    expect(getDefaultCLI()).toBe('claude');
  });

  it('should handle case-insensitive values', () => {
    process.env['BOT_CLI_TYPE'] = 'CODEX';
    expect(getDefaultCLI()).toBe('codex');
  });

  it('should default unknown values to claude', () => {
    process.env['BOT_CLI_TYPE'] = 'unknown';
    expect(getDefaultCLI()).toBe('claude');
  });
});
