import { describe, it, expect } from 'vitest';
import { splitMessage, codeBlock, formatToolUse } from '../src/discord-utils.js';

describe('discord-utils', () => {
  describe('splitMessage', () => {
    it('should not split short messages', () => {
      const result = splitMessage('hello');
      expect(result).toEqual(['hello']);
    });

    it('should split long messages at newlines', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'x'.repeat(30)}`);
      const text = lines.join('\n');
      const result = splitMessage(text, 500);

      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(500);
      }
      // All content should be preserved
      expect(result.join('\n').replace(/\n+/g, '\n')).toContain('Line 0');
      expect(result.join('\n').replace(/\n+/g, '\n')).toContain('Line 99');
    });

    it('should handle empty string', () => {
      expect(splitMessage('')).toEqual(['']);
    });
  });

  describe('codeBlock', () => {
    it('should wrap text in code block', () => {
      expect(codeBlock('hello')).toBe('```\nhello\n```');
    });

    it('should add language tag', () => {
      expect(codeBlock('const x = 1', 'ts')).toBe('```ts\nconst x = 1\n```');
    });

    it('should escape triple backticks', () => {
      const result = codeBlock('a ``` b');
      expect(result).not.toContain('``````');
      expect(result).toContain('`\u200b``');
    });
  });

  describe('formatToolUse', () => {
    it('should format tool name', () => {
      expect(formatToolUse('Bash')).toBe('┣ **Bash**');
    });

    it('should include command detail', () => {
      const result = formatToolUse('Bash', { command: 'ls -la' });
      expect(result).toBe('┣ **Bash**: `ls -la`');
    });

    it('should include file_path detail', () => {
      const result = formatToolUse('Read', { file_path: '/src/index.ts' });
      expect(result).toBe('┣ **Read**: `/src/index.ts`');
    });

    it('should include pattern detail', () => {
      const result = formatToolUse('Grep', { pattern: 'TODO' });
      expect(result).toBe('┣ **Grep**: `TODO`');
    });

    it('should handle no metadata', () => {
      expect(formatToolUse('Edit', {})).toBe('┣ **Edit**');
    });
  });
});
