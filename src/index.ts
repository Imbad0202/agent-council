import 'dotenv/config';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadAgentConfig, loadCouncilConfig } from './config.js';
import { ClaudeProvider } from './worker/providers/claude.js';
import { AgentWorker } from './worker/agent-worker.js';
import { GatewayRouter } from './gateway/router.js';
import { createBot, getLastMessageThreadId } from './telegram/bot.js';
import { MemoryDB } from './memory/db.js';
import { UsageTracker } from './memory/tracker.js';
import { SessionLifecycle } from './memory/lifecycle.js';
import { PatternDetector } from './council/pattern-detector.js';

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

  // Phase 2: Initialize memory DB and modules
  if (councilConfig.memory) {
    const dataDir = resolve('data');
    const memoryDb = new MemoryDB(resolve(councilConfig.memory.dbPath));
    const tracker = new UsageTracker(memoryDb);
    const lifecycle = new SessionLifecycle(councilConfig.memory, provider, agentConfigs[0].model);
    const patternDetector = new PatternDetector(
      councilConfig.antiPattern ?? { enabled: false, detectionModel: '', startAfterTurn: 3, detectEveryNTurns: 2 },
      provider,
    );

    router.setPhase2({
      db: memoryDb,
      tracker,
      lifecycle,
      patternDetector,
      provider,
      dataDir,
    });

    console.log('Phase 2 modules initialized: memory DB, usage tracker, lifecycle, pattern detector');
  }

  const bot = createBot({ token: botToken, groupChatId, agentNames }, router);

  sendToTelegram = async (agentId: string, content: string) => {
    const agentName = agentNames[agentId] ?? agentId;
    const formatted = `\u{1F916} ${agentName}\n\n${content}`;
    const threadId = getLastMessageThreadId();
    await bot.api.sendMessage(groupChatId, formatted, {
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  };

  console.log('Agent Council starting...');
  console.log(`Group chat ID: ${groupChatId}`);
  console.log(`Memory sync path: ${memorySyncPath}`);

  // Clear any stale long-polling connections before starting.
  // Telegram holds long-poll connections for up to 30s. A short getUpdates
  // with timeout=1 will either succeed (claiming the slot) or fail with 409
  // (meaning a stale connection exists). We retry until we get a clean slot.
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  console.log('Waiting for clean Telegram polling slot...');
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await bot.api.raw.getUpdates({ offset: -1, limit: 1, timeout: 1 });
      console.log('Polling slot acquired.');
      break;
    } catch (err: unknown) {
      const isConflict = err instanceof Error && err.message.includes('409');
      if (isConflict && attempt < 6) {
        console.log(`  Stale connection detected (attempt ${attempt}/6), waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5_000));
      } else if (!isConflict) {
        break; // Non-conflict error, proceed anyway
      } else {
        console.log('  Could not acquire clean slot after 6 attempts, starting anyway...');
      }
    }
  }

  await bot.start({
    drop_pending_updates: true,
    onStart: () => console.log('Agent Council is running! Send a message in the Telegram group.'),
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
