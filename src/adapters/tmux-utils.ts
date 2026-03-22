import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from '../logger.js';

const logger = createLogger('TMUX');

function ensureTmuxDir(): void {
  const tmuxDir = process.env['TMUX_TMPDIR'];
  if (tmuxDir && !fs.existsSync(tmuxDir)) {
    fs.mkdirSync(tmuxDir, { recursive: true });
    logger.log(`Created TMUX_TMPDIR: ${tmuxDir}`);
  }
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  ensureTmuxDir();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await exec('which', ['tmux']);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await exec('tmux', ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxCreateSession(name: string, cmd: string, cwd: string): Promise<void> {
  logger.log(`Creating tmux session: ${name} cmd="${cmd}" cwd=${cwd}`);
  // Set large scrollback buffer for long sessions
  await exec('tmux', [
    'new-session', '-d',
    '-s', name,
    '-c', cwd,
    '-x', '200', '-y', '50',
    cmd,
  ]);
  // Increase scrollback limit
  await exec('tmux', ['set-option', '-t', name, 'history-limit', '50000']).catch(() => {});
}

export async function tmuxSendKeys(name: string, text: string): Promise<void> {
  if (text) {
    // Use -l (literal) to avoid key name interpretation
    await exec('tmux', ['send-keys', '-t', name, '-l', text]);
  }
  // Press Enter
  await exec('tmux', ['send-keys', '-t', name, 'Enter']);
}

export async function tmuxSendControlC(name: string): Promise<void> {
  await exec('tmux', ['send-keys', '-t', name, 'C-c']);
}

export async function tmuxCapturePaneAll(name: string): Promise<string> {
  // Capture entire scrollback (-S -) and visible area (-E -)
  // If scrollback is empty, fall back to visible pane only
  try {
    const { stdout } = await exec('tmux', ['capture-pane', '-p', '-S', '-', '-E', '-', '-t', name]);
    if (stdout.trim()) return stdout;
  } catch {}
  // Fallback: visible pane only
  const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', name]);
  return stdout;
}

export async function tmuxKillSession(name: string): Promise<void> {
  logger.log(`Killing tmux session: ${name}`);
  await exec('tmux', ['kill-session', '-t', name]).catch(() => {});
}

export async function tmuxListSessions(prefix: string): Promise<string[]> {
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').filter(s => s.startsWith(prefix));
  } catch {
    return [];
  }
}
