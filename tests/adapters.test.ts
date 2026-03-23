import { describe, it, expect } from 'vitest';
import { ClaudeAgentAdapter } from '../src/adapters/claude-agent.js';
import { CodexAppServerAdapter } from '../src/adapters/codex-appserver.js';

describe('adapters', () => {
  describe('ClaudeAgentAdapter', () => {
    it('should have correct name', () => {
      const adapter = new ClaudeAgentAdapter();
      expect(adapter.name).toBe('claude');
    });
  });

  describe('CodexAppServerAdapter', () => {
    it('should have correct name', () => {
      const adapter = new CodexAppServerAdapter();
      expect(adapter.name).toBe('codex');
    });
  });
});
