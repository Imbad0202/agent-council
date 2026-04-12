import 'dotenv/config';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadAgentConfig, loadCouncilConfig } from './config.js';
import { ClaudeProvider } from './worker/providers/claude.js';
import { AgentWorker } from './worker/agent-worker.js';
import { GatewayRouter } from './gateway/router.js';
import { createBot } from './telegram/bot.js';

async function main() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const groupChatId = Number(process.env.TELEGRAM_GROUP_CHAT_ID);
  const memorySyncPath = process.env.MEMORY_SYNC_PATH;

  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required');
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (!groupChatId) throw new Error('TELEGRAM_GROUP_CHAT_ID is required');
  if (!memorySyncPath) throw new Error('MEMORY_SYNC_PATH is required');

  const configDir = resolve('config');
  const councilConfig = loadCouncilConfig(resolve(configDir, 'council.yaml'));

  const agentConfigDir = resolve(configDir, 'agents');
  const agentFiles = readdirSync(agentConfigDir).filter((f) => f.endsWith('.yaml'));
  const agentConfigs = agentFiles.map((f) => loadAgentConfig(resolve(agentConfigDir, f)));

  console.log(`Loaded ${agentConfigs.length} agents: ${agentConfigs.map((a) => a.name).join(', ')}`);

  const provider = new ClaudeProvider(anthropicKey);
  const workers = agentConfigs.map((config) => new AgentWorker(config, provider, memorySyncPath));

  const agentNames: Record<string, string> = {};
  for (const config of agentConfigs) {
    agentNames[config.id] = config.name;
  }

  let sendToTelegram: (agentId: string, content: string) => Promise<void> = async () => {};

  const router = new GatewayRouter(workers, councilConfig, async (agentId, content) => {
    await sendToTelegram(agentId, content);
  });

  const bot = createBot({ token: botToken, groupChatId, agentNames }, router);

  sendToTelegram = async (agentId: string, content: string) => {
    const agentName = agentNames[agentId] ?? agentId;
    const formatted = `\u{1F916} ${agentName}\n\n${content}`;
    await bot.api.sendMessage(groupChatId, formatted);
  };

  console.log('Agent Council starting...');
  console.log(`Group chat ID: ${groupChatId}`);
  console.log(`Memory sync path: ${memorySyncPath}`);

  await bot.start({
    onStart: () => console.log('Agent Council is running! Send a message in the Telegram group.'),
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
