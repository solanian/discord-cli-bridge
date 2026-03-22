import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  getChannelConfig,
  setChannelCLI,
  setChannelModel,
  setChannelEffort,
  setChannelMaxBudget,
  createSession,
  getSession,
  updateSessionStatus,
  updateSessionCLIId,
  listSessions,
  setConfigValue,
  getConfigValue,
} from '../src/database.js';

// Use in-memory DB for tests
beforeEach(() => {
  process.env['DATA_DIR'] = ':memory:';
});

afterEach(() => {
  closeDatabase();
});

describe('database', () => {
  describe('channel operations', () => {
    it('should set and get channel config', () => {
      // Use temp file for test
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      const db = initDatabase();

      setChannelDirectory('ch1', '/home/user/project', 'claude');
      const config = getChannelConfig('ch1');

      expect(config).toBeDefined();
      expect(config!.directory).toBe('/home/user/project');
      expect(config!.cli_type).toBe('claude');
      expect(config!.model).toBeNull();
      expect(config!.effort).toBeNull();
      expect(config!.max_budget_usd).toBeNull();

      closeDatabase();
      // Cleanup
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return undefined for unknown channel', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      expect(getChannelConfig('unknown')).toBeUndefined();

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should update channel CLI type', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      setChannelDirectory('ch1', '/project', 'claude');
      setChannelCLI('ch1', 'codex');

      const config = getChannelConfig('ch1');
      expect(config!.cli_type).toBe('codex');

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should update model, effort, budget', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      setChannelDirectory('ch1', '/project', 'claude');
      setChannelModel('ch1', 'opus');
      setChannelEffort('ch1', 'high');
      setChannelMaxBudget('ch1', 5.0);

      const config = getChannelConfig('ch1');
      expect(config!.model).toBe('opus');
      expect(config!.effort).toBe('high');
      expect(config!.max_budget_usd).toBe(5.0);

      // Reset
      setChannelModel('ch1', null);
      setChannelEffort('ch1', null);
      setChannelMaxBudget('ch1', null);

      const reset = getChannelConfig('ch1');
      expect(reset!.model).toBeNull();
      expect(reset!.effort).toBeNull();
      expect(reset!.max_budget_usd).toBeNull();

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should upsert channel directory', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      setChannelDirectory('ch1', '/old', 'claude');
      setChannelDirectory('ch1', '/new', 'codex');

      const config = getChannelConfig('ch1');
      expect(config!.directory).toBe('/new');
      expect(config!.cli_type).toBe('codex');

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('session operations', () => {
    it('should create and get session with first_prompt', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      createSession({
        threadId: 'th1',
        channelId: 'ch1',
        cliType: 'claude',
        directory: '/project',
        firstPrompt: 'hello world',
      });

      const session = getSession('th1');
      expect(session).toBeDefined();
      expect(session!.thread_id).toBe('th1');
      expect(session!.cli_type).toBe('claude');
      expect(session!.status).toBe('active');

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should update session status', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      createSession({ threadId: 'th1', channelId: 'ch1', cliType: 'codex', directory: '/p' });
      updateSessionStatus('th1', 'idle');

      expect(getSession('th1')!.status).toBe('idle');

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should update CLI session ID', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      createSession({ threadId: 'th1', channelId: 'ch1', cliType: 'claude', directory: '/p' });
      updateSessionCLIId('th1', 'ses-abc-123');

      expect(getSession('th1')!.cli_session_id).toBe('ses-abc-123');

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should list sessions by channel', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      createSession({ threadId: 'th1', channelId: 'ch1', cliType: 'claude', directory: '/p', firstPrompt: 'first' });
      createSession({ threadId: 'th2', channelId: 'ch1', cliType: 'claude', directory: '/p', firstPrompt: 'second' });
      createSession({ threadId: 'th3', channelId: 'ch2', cliType: 'codex', directory: '/q', firstPrompt: 'other channel' });

      const ch1Sessions = listSessions('ch1');
      expect(ch1Sessions).toHaveLength(2);

      const allSessions = listSessions();
      expect(allSessions).toHaveLength(3);

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('config operations', () => {
    it('should set and get config values', () => {
      const tmpDir = '/tmp/discord-cli-bridge-test-' + Date.now();
      process.env['DATA_DIR'] = tmpDir;
      initDatabase();

      setConfigValue('key1', 'value1');
      expect(getConfigValue('key1')).toBe('value1');

      // Upsert
      setConfigValue('key1', 'value2');
      expect(getConfigValue('key1')).toBe('value2');

      expect(getConfigValue('unknown')).toBeUndefined();

      closeDatabase();
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
