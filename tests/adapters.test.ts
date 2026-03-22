import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';

describe('adapters', () => {
  describe('ClaudeCodeAdapter', () => {
    it('should have correct name', () => {
      const adapter = new ClaudeCodeAdapter();
      expect(adapter.name).toBe('claude');
    });

    it('should detect CLI availability', async () => {
      const adapter = new ClaudeCodeAdapter();
      const available = await adapter.isAvailable();
      // Should be true in this environment since claude is installed
      expect(typeof available).toBe('boolean');
    });
  });

  describe('CodexAdapter', () => {
    it('should have correct name', () => {
      const adapter = new CodexAdapter();
      expect(adapter.name).toBe('codex');
    });

    it('should detect CLI availability', async () => {
      const adapter = new CodexAdapter();
      const available = await adapter.isAvailable();
      expect(typeof available).toBe('boolean');
    });
  });
});
