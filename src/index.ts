import 'dotenv/config';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadAgentConfig, loadCouncilConfig } from './config.js';
import { createProvider } from './worker/providers/factory.js';
import { AgentWorker } from './worker/agent-worker.js';
import { GatewayRouter } from './gateway/router.js';
import { BotManager } from './telegram/bot.js';
import { MemoryDB } from './memory/db.js';
import { UsageTracker } from './memory/tracker.js';
import { SessionLifecycle } from './memory/lifecycle.js';
import { PatternDetector } from './council/pattern-detector.js';
import { ParticipationManager } from './council/participation.js';

async function main() {
  const groupChatId = Number(process.env.TELEGRAM_GROUP_CHAT_ID);
  if (!groupChatId) throw new Error('TELEGRAM_GROUP_CHAT_ID is required');

  const memorySyncPath = process.env.MEMORY_SYNC_PATH;
  if (!memorySyncPath) console.log('MEMORY_SYNC_PATH not set — running without external memory');

  const configDir = resolve('config');
  const councilConfig = loadCouncilConfig(resolve(configDir, 'council.yaml'));

  const agentConfigDir = resolve(configDir, 'agents');
  const agentFiles = readdirSync(agentConfigDir).filter((f) => f.endsWith('.yaml'));
  const agentConfigs = agentFiles.map((f) => loadAgentConfig(resolve(agentConfigDir, f)));

  console.log(`Loaded ${agentConfigs.length} agents: ${agentConfigs.map((a) => `${a.name}(${a.provider})`).join(', ')}`);

  // Create per-agent providers (each agent can use different LLM)
  const workers = agentConfigs.map((config) => {
    const provider = createProvider(config.provider);
    return new AgentWorker(config, provider, memorySyncPath ?? '');
  });

  // Bot manager: one bot per agent
  const listenerAgent = councilConfig.participation?.listenerAgent || agentConfigs[0].id;
  const botManager = new BotManager({
    groupChatId,
    agents: agentConfigs,
    listenerAgentId: listenerAgent,
  });

  console.log(`Bot manager: ${botManager.getBotCount()} bots, listener: ${listenerAgent}`);

  // Router with multi-bot send function
  const router = new GatewayRouter(workers, councilConfig, async (agentId, content, threadId) => {
    const agentName = agentConfigs.find((a) => a.id === agentId)?.name ?? agentId;
    await botManager.sendMessage(agentId, agentName, content, threadId);
  });

  // Participation manager
  if (councilConfig.participation) {
    const participationManager = new ParticipationManager(councilConfig.participation, agentConfigs);
    router.setParticipation(participationManager);
    console.log('Participation manager initialized');
  }

  // Phase 2: Memory modules
  if (councilConfig.memory) {
    const dataDir = resolve('data');
    const mainProvider = createProvider(agentConfigs[0].provider);
    const memoryDb = new MemoryDB(resolve(councilConfig.memory.dbPath));
    const tracker = new UsageTracker(memoryDb);
    const lifecycle = new SessionLifecycle(councilConfig.memory, mainProvider, agentConfigs[0].model);
    const patternDetector = new PatternDetector(
      councilConfig.antiPattern ?? { enabled: false, detectionModel: '', startAfterTurn: 3, detectEveryNTurns: 2 },
      mainProvider,
    );

    router.setPhase2({
      db: memoryDb,
      tracker,
      lifecycle,
      patternDetector,
      provider: mainProvider,
      dataDir,
    });

    console.log('Phase 2 modules initialized');
  }

  // Setup listener and start
  botManager.setupListener(router);

  const listenerBot = botManager.getListenerBot();

  console.log('Agent Council starting...');
  console.log(`Group chat ID: ${groupChatId}`);

  await listenerBot.api.deleteWebhook({ drop_pending_updates: true });

  console.log('Waiting for clean Telegram polling slot...');
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await listenerBot.api.raw.getUpdates({ offset: -1, limit: 1, timeout: 1 });
      console.log('Polling slot acquired.');
      break;
    } catch (err: unknown) {
      const isConflict = err instanceof Error && err.message.includes('409');
      if (isConflict && attempt < 6) {
        console.log(`  Stale connection (attempt ${attempt}/6), waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5_000));
      } else if (!isConflict) {
        break;
      } else {
        console.log('  Could not acquire clean slot, starting anyway...');
      }
    }
  }

  await listenerBot.start({
    drop_pending_updates: true,
    onStart: () => console.log('Agent Council is running! Send a message in the Telegram group.'),
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
