import {
  SlashCommandBuilder,
  type Client,
  type Interaction,
  type ChatInputCommandInteraction,
  REST,
  Routes,
  ChannelType,
  type ThreadChannel,
} from 'discord.js';
import { execFileSync, spawn } from 'node:child_process';
import { createLogger } from './logger.js';
import {
  setChannelDirectory,
  setChannelCLI,
  setChannelModel,
  setChannelEffort,
  setChannelMaxBudget,
  getChannelConfig,
  getSession,
  listSessions,
} from './database.js';
import { getDefaultCLI } from './config.js';
import { abortSession, isSessionActive } from './session-manager.js';
import { sendThreadMessage } from './discord-utils.js';
import { startSession } from './session-manager.js';
import type { OutputChunk } from './adapters/base.js';
import type { CLIType } from './config.js';
import fs from 'node:fs';

const logger = createLogger('CMD');

const claudeModels: Array<{ name: string; value: string }> = [
  { name: 'Opus 4.6 (1M context)', value: 'claude-opus-4-6' },
  { name: 'Opus 4', value: 'opus' },
  { name: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { name: 'Sonnet 4', value: 'sonnet' },
  { name: 'Haiku 4.5', value: 'haiku' },
  { name: 'default (reset)', value: 'default' },
];

const codexModels: Array<{ name: string; value: string }> = [
  { name: 'GPT-5.4', value: 'gpt-5.4' },
  { name: 'GPT-5.4 mini', value: 'gpt-5.4-mini' },
  { name: 'Codex 5.3', value: 'codex-5.3' },
  { name: 'GPT-5.1', value: 'gpt-5.1' },
  { name: 'o3', value: 'o3' },
  { name: 'o4-mini', value: 'o4-mini' },
  { name: 'codex-mini', value: 'codex-mini-latest' },
  { name: 'default (reset)', value: 'default' },
];

const claudeEffortLevels: Array<{ name: string; value: string }> = [
  { name: 'low', value: 'low' },
  { name: 'medium', value: 'medium' },
  { name: 'high', value: 'high' },
  { name: 'max', value: 'max' },
  { name: 'default (reset)', value: 'default' },
];

const codexEffortLevels: Array<{ name: string; value: string }> = [
  { name: 'low', value: 'low' },
  { name: 'medium', value: 'medium' },
  { name: 'high', value: 'high' },
  { name: 'default (reset)', value: 'default' },
];

function buildCommands(cliType: CLIType) {
  const models = cliType === 'claude' ? claudeModels : codexModels;
  const efforts = cliType === 'claude' ? claudeEffortLevels : codexEffortLevels;

  const cmds = [
    new SlashCommandBuilder()
      .setName('set-project')
      .setDescription('Set the project directory for this channel')
      .addStringOption(option =>
        option.setName('path')
          .setDescription('Absolute path to the project directory')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('session')
      .setDescription('Start a new CLI session with a prompt')
      .addStringOption(option =>
        option.setName('prompt')
          .setDescription('The prompt to send')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('abort')
      .setDescription('Abort the current running session in this thread'),

    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Set the AI model for this channel')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('Select a model')
          .setRequired(true)
          .addChoices(...models)
      ),

    new SlashCommandBuilder()
      .setName('effort')
      .setDescription('Set thinking effort level for this channel')
      .addStringOption(option =>
        option.setName('level')
          .setDescription('Select effort level')
          .setRequired(true)
          .addChoices(...efforts)
      ),

    new SlashCommandBuilder()
      .setName('sessions')
      .setDescription('List recent sessions in this channel'),

    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume a previous session by thread ID')
      .addStringOption(option =>
        option.setName('thread')
          .setDescription('Thread ID to resume')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('prompt')
          .setDescription('Follow-up prompt')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('usage')
      .setDescription('Show current API usage and rate limits'),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show the current channel/thread configuration'),
  ];

  // Budget is claude-only
  if (cliType === 'claude') {
    cmds.push(
      new SlashCommandBuilder()
        .setName('budget')
        .setDescription('Set max budget per session in USD')
        .addNumberOption(option =>
          option.setName('amount')
            .setDescription('Max USD per session (e.g. 1.0, 5.0). Use 0 to reset.')
            .setRequired(true)
        ),
    );
  }

  return cmds;
}

export async function registerSlashCommands(client: Client<true>): Promise<void> {
  const rest = new REST().setToken(client.token);
  const cliType = getDefaultCLI();
  const commands = buildCommands(cliType);
  const body = commands.map(c => c.toJSON());

  // Clear stale global commands
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
  } catch {}

  // Register as guild commands (instant update, no 1-hour cache)
  for (const guild of client.guilds.cache.values()) {
    try {
      logger.log(`Registering ${commands.length} ${cliType} slash commands in guild ${guild.name}...`);
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body },
      );
      logger.log(`Registered ${commands.length} slash commands in ${guild.name}`);
    } catch (error) {
      logger.error(`Failed to register slash commands in ${guild.name}:`, error);
    }
  }
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case 'set-project':
      await handleSetProject(interaction);
      break;
    case 'session':
      await handleSession(interaction);
      break;
    case 'abort':
      await handleAbort(interaction);
      break;
    case 'model':
      await handleModel(interaction);
      break;
    case 'effort':
      await handleEffort(interaction);
      break;
    case 'budget':
      await handleBudget(interaction);
      break;
    case 'sessions':
      await handleSessions(interaction);
      break;
    case 'resume':
      await handleResume(interaction);
      break;
    case 'usage':
      await handleUsage(interaction);
      break;
    case 'status':
      await handleStatus(interaction);
      break;
    default:
      await interaction.reply({ content: 'Unknown command', ephemeral: true });
  }
}

async function handleSetProject(interaction: ChatInputCommandInteraction): Promise<void> {
  const dirPath = interaction.options.getString('path', true);
  const cli = (interaction.options.getString('cli') || 'claude') as CLIType;

  if (!fs.existsSync(dirPath)) {
    await interaction.reply({ content: `Directory does not exist: \`${dirPath}\``, ephemeral: true });
    return;
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    await interaction.reply({ content: `Path is not a directory: \`${dirPath}\``, ephemeral: true });
    return;
  }

  setChannelDirectory(interaction.channelId, dirPath, cli);
  await interaction.reply({
    content: `Channel configured:\nDirectory: \`${dirPath}\`\nCLI: **${cli}**\n\nSend a message in this channel to start a session.`,
  });
}

async function handleSetCLI(interaction: ChatInputCommandInteraction): Promise<void> {
  const cli = interaction.options.getString('cli', true) as CLIType;
  const config = getChannelConfig(interaction.channelId);
  if (!config) {
    await interaction.reply({ content: 'No project configured. Use `/set-project` first.', ephemeral: true });
    return;
  }
  setChannelCLI(interaction.channelId, cli);
  await interaction.reply({ content: `CLI changed to **${cli}** for this channel.` });
}

async function handleSession(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString('prompt', true);
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: 'This command can only be used in a text channel.', ephemeral: true });
    return;
  }
  const config = getChannelConfig(channel.id);
  if (!config) {
    await interaction.reply({ content: 'No project configured. Use `/set-project` first.', ephemeral: true });
    return;
  }
  await interaction.reply({ content: `Starting ${config.cli_type} session...` });
  const reply = await interaction.fetchReply();
  const thread = await reply.startThread({ name: prompt.slice(0, 80) || 'CLI session' });

  await thread.sendTyping();
  const typingInterval = setInterval(() => { thread.sendTyping().catch(() => {}); }, 7000);
  const startTime = Date.now();

  await startSession({
    threadId: thread.id,
    channelId: channel.id,
    prompt,
    cliType: config.cli_type,
    workingDirectory: config.directory,
    model: config.model || undefined,
    effort: config.effort || undefined,
    maxBudgetUsd: config.max_budget_usd || undefined,
    onOutput: (chunk) => handleChunkInThread(thread, chunk),
    onComplete: () => {
      clearInterval(typingInterval);
      const elapsed = Date.now() - startTime;
      const projectName = config.directory.split('/').pop() || 'project';
      sendThreadMessage(thread, `${projectName} · ${formatDuration(elapsed)} · ${config.cli_type}`).catch(() => {});
    },
    onError: (error) => {
      clearInterval(typingInterval);
      sendThreadMessage(thread, `Error: ${error.message.slice(0, 1800)}`).catch(() => {});
    },
  });
}

function handleChunkInThread(thread: ThreadChannel, chunk: OutputChunk): void {
  switch (chunk.type) {
    case 'text':
      sendThreadMessage(thread, `${chunk.content}`).catch(() => {});
      break;
    case 'tool_use':
      sendThreadMessage(thread, `${chunk.content}`).catch(() => {});
      break;
    case 'error':
      sendThreadMessage(thread, `${chunk.content.slice(0, 1800)}`).catch(() => {});
      break;
  }
}

async function handleModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const modelName = interaction.options.getString('name', true);
  const channelId = interaction.channelId;
  const config = getChannelConfig(channelId);
  if (!config) {
    await interaction.reply({ content: 'No project configured. Use `/set-project` first.', ephemeral: true });
    return;
  }
  if (modelName === 'default') {
    setChannelModel(channelId, null);
    await interaction.reply({ content: 'Model reset to default.' });
  } else {
    setChannelModel(channelId, modelName);
    await interaction.reply({ content: `Model set to **${modelName}** for this channel.` });
  }
}

async function handleEffort(interaction: ChatInputCommandInteraction): Promise<void> {
  const level = interaction.options.getString('level', true);
  const channelId = interaction.channelId;
  const config = getChannelConfig(channelId);
  if (!config) {
    await interaction.reply({ content: 'No project configured. Use `/set-project` first.', ephemeral: true });
    return;
  }
  if (level === 'default') {
    setChannelEffort(channelId, null);
    await interaction.reply({ content: 'Effort level reset to default.' });
  } else {
    setChannelEffort(channelId, level);
    await interaction.reply({ content: `Effort level set to **${level}** for this channel.` });
  }
}

async function handleBudget(interaction: ChatInputCommandInteraction): Promise<void> {
  const amount = interaction.options.getNumber('amount', true);
  const channelId = interaction.channelId;
  const config = getChannelConfig(channelId);
  if (!config) {
    await interaction.reply({ content: 'No project configured. Use `/set-project` first.', ephemeral: true });
    return;
  }
  if (amount <= 0) {
    setChannelMaxBudget(channelId, null);
    await interaction.reply({ content: 'Budget limit removed.' });
  } else {
    setChannelMaxBudget(channelId, amount);
    await interaction.reply({ content: `Max budget set to **$${amount.toFixed(2)}** per session.` });
  }
}

async function handleUsage(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const cliType = getDefaultCLI();

  if (cliType === 'claude') {
    try {
      const usageInfo = await getClaudeUsage();
      await interaction.editReply({ content: usageInfo });
    } catch (error) {
      await interaction.editReply({ content: `Failed to get usage: ${(error as Error).message}` });
    }
  } else {
    // Codex doesn't expose rate limit info via CLI
    await interaction.editReply({ content: 'Usage info is only available for Claude Code.' });
  }
}

function getClaudeUsage(): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', 'say ok'];
    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.stderr?.on('data', () => {});

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Timeout'));
    }, 15000);

    proc.on('close', () => {
      clearTimeout(timeout);
      const lines = output.split('\n').filter(l => l.trim());

      // Parse rate_limit_event
      let rateLimitInfo: any = null;
      // Parse result for cost
      let resultInfo: any = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'rate_limit_event') {
            rateLimitInfo = event.rate_limit_info;
          }
          if (event.type === 'result') {
            resultInfo = event;
          }
        } catch {}
      }

      const parts: string[] = ['**API Usage**'];

      if (rateLimitInfo) {
        const resetsAt = rateLimitInfo.resetsAt ? new Date(rateLimitInfo.resetsAt * 1000) : null;
        const now = new Date();

        parts.push(`Status: ${rateLimitInfo.status === 'allowed' ? 'Allowed' : rateLimitInfo.status}`);
        parts.push(`Rate limit type: ${rateLimitInfo.rateLimitType || 'unknown'}`);

        if (resetsAt) {
          const diffMs = resetsAt.getTime() - now.getTime();
          const diffMin = Math.max(0, Math.floor(diffMs / 60000));
          const hours = Math.floor(diffMin / 60);
          const mins = diffMin % 60;
          parts.push(`Resets in: ${hours}h ${mins}m`);
          parts.push(`Resets at: ${resetsAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
        }

        if (rateLimitInfo.overageStatus) {
          parts.push(`Overage: ${rateLimitInfo.overageStatus}`);
        }
      }

      if (resultInfo) {
        if (resultInfo.total_cost_usd !== undefined) {
          parts.push(`\n**Last probe cost:** $${resultInfo.total_cost_usd.toFixed(6)}`);
        }
        const usage = resultInfo.usage;
        if (usage) {
          parts.push(`Service tier: ${usage.service_tier || 'unknown'}`);
        }
        // Show per-model usage if available
        if (resultInfo.modelUsage) {
          parts.push('\n**Model usage (this probe):**');
          for (const [model, info] of Object.entries(resultInfo.modelUsage)) {
            const m = info as any;
            parts.push(`\`${model}\`: ${m.inputTokens || 0} in / ${m.outputTokens || 0} out / $${(m.costUSD || 0).toFixed(4)}`);
            if (m.contextWindow) parts.push(`  Context window: ${(m.contextWindow / 1000).toFixed(0)}k tokens`);
          }
        }
      }

      if (parts.length === 1) {
        parts.push('No usage data available.');
      }

      resolve(parts.join('\n'));
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function handleSessions(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const sessions = listSessions(channelId, 15);

  if (sessions.length === 0) {
    await interaction.reply({ content: 'No sessions found in this channel.', ephemeral: true });
    return;
  }

  const lines = sessions.map((s, i) => {
    const date = s.updated_at.slice(0, 16).replace('T', ' ');
    const preview = s.first_prompt
      ? s.first_prompt.replace(/\n/g, ' ').slice(0, 50) + (s.first_prompt.length > 50 ? '...' : '')
      : '(no prompt)';
    return `\`${i + 1}\` \`${s.thread_id}\`\n   ${s.status} · ${date} · ${preview}`;
  });

  await interaction.reply({
    content: `**Recent sessions** (use thread ID with \`/resume\`)\n${lines.join('\n')}`,
    ephemeral: true,
  });
}

async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
  const threadId = interaction.options.getString('thread', true);
  const prompt = interaction.options.getString('prompt', true);

  const session = getSession(threadId);
  if (!session) {
    await interaction.reply({ content: `Session not found for thread \`${threadId}\`.`, ephemeral: true });
    return;
  }

  if (!session.cli_session_id) {
    await interaction.reply({ content: 'This session has no CLI session ID to resume.', ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: 'This command can only be used in a text channel.', ephemeral: true });
    return;
  }

  const config = getChannelConfig(channel.id);
  const dir = config?.directory || session.directory;

  await interaction.reply({ content: `Resuming session \`${session.cli_session_id.slice(0, 8)}...\`` });
  const reply = await interaction.fetchReply();
  const thread = await reply.startThread({ name: `Resume: ${prompt.slice(0, 60)}` });

  await thread.sendTyping();
  const typingInterval = setInterval(() => { thread.sendTyping().catch(() => {}); }, 7000);
  const startTime = Date.now();

  await startSession({
    threadId: thread.id,
    channelId: channel.id,
    prompt,
    cliType: session.cli_type,
    workingDirectory: dir,
    sessionId: session.cli_session_id,
    model: config?.model || undefined,
    effort: config?.effort || undefined,
    maxBudgetUsd: config?.max_budget_usd || undefined,
    onOutput: (chunk) => handleChunkInThread(thread, chunk),
    onComplete: () => {
      clearInterval(typingInterval);
      const elapsed = Date.now() - startTime;
      const projectName = dir.split('/').pop() || 'project';
      sendThreadMessage(thread, `${projectName} · ${formatDuration(elapsed)} · ${session.cli_type} (resumed)`).catch(() => {});
    },
    onError: (error) => {
      clearInterval(typingInterval);
      sendThreadMessage(thread, `Error: ${error.message.slice(0, 1800)}`).catch(() => {});
    },
  });
}

async function handleAbort(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) {
    await interaction.reply({ content: 'Use this command inside a session thread.', ephemeral: true });
    return;
  }
  const aborted = await abortSession(channel.id);
  if (aborted) {
    await interaction.reply({ content: 'Session aborted.' });
  } else {
    await interaction.reply({ content: 'No active session in this thread.', ephemeral: true });
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: 'Cannot determine channel.', ephemeral: true });
    return;
  }

  if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
    const session = getSession(channel.id);
    if (session) {
      const active = isSessionActive(channel.id);
      await interaction.reply({
        content: [
          `**Thread Session Status**`,
          `Directory: \`${session.directory}\``,
          `CLI: **${session.cli_type}**`,
          `Status: ${active ? 'Active' : 'Idle'}`,
          session.cli_session_id ? `Session ID: \`${session.cli_session_id}\`` : '',
        ].filter(Boolean).join('\n'),
        ephemeral: true,
      });
    } else {
      await interaction.reply({ content: 'No session for this thread.', ephemeral: true });
    }
    return;
  }

  const config = getChannelConfig(channel.id);
  if (config) {
    await interaction.reply({
      content: [
        `**Channel Configuration**`,
        `Directory: \`${config.directory}\``,
        `CLI: **${config.cli_type}**`,
        `Model: ${config.model ? `**${config.model}**` : 'default'}`,
        `Effort: ${config.effort ? `**${config.effort}**` : 'default'}`,
        config.max_budget_usd ? `Budget: **$${config.max_budget_usd.toFixed(2)}**/session` : '',
      ].filter(Boolean).join('\n'),
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: 'This channel has no project configured. Use `/set-project` to set one up.',
      ephemeral: true,
    });
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}
