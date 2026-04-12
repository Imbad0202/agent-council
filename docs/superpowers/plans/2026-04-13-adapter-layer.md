# Adapter Layer + CLI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple agent-council from Telegram transport with an Adapter interface, refactor Telegram into an adapter, and add a CLI adapter with REPL, single-shot mode, session persistence, and memory management commands.

**Architecture:** InputAdapter/OutputAdapter interfaces define a platform contract. A factory function selects the adapter based on `--adapter` CLI flag. index.ts wires the chosen adapter to the EventBus core. TelegramAdapter wraps existing BotManager. CliAdapter uses readline + chalk for interactive terminal sessions.

**Tech Stack:** TypeScript, Node.js readline, chalk v5 (ESM), existing EventBus/grammY/better-sqlite3

**Spec:** `docs/superpowers/specs/2026-04-13-adapter-layer-design.md`

---

## Phase 1: Adapter Interface + Types

### Task 1: Create adapter types

**Files:**
- Create: `src/adapters/types.ts`
- Test: `tests/adapters/types.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/adapters/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  AdapterMessage,
  RichMetadata,
  InputAdapter,
  OutputAdapter,
  Adapter,
} from '../../src/adapters/types.js';

describe('Adapter types', () => {
  it('AdapterMessage has required fields', () => {
    const msg: AdapterMessage = { content: 'hello' };
    expect(msg.content).toBe('hello');
    expect(msg.threadId).toBeUndefined();
  });

  it('AdapterMessage supports optional threadId', () => {
    const msg: AdapterMessage = { content: 'hello', threadId: 5 };
    expect(msg.threadId).toBe(5);
  });

  it('RichMetadata has required agentName and optional fields', () => {
    const meta: RichMetadata = { agentName: '花花' };
    expect(meta.agentName).toBe('花花');
    expect(meta.emotion).toBeUndefined();
    expect(meta.intensity).toBeUndefined();
  });

  it('RichMetadata supports all emotion values', () => {
    const emotions: RichMetadata['emotion'][] = [
      'neutral', 'assertive', 'questioning', 'conceding', 'thoughtful', 'frustrated',
    ];
    expect(emotions).toHaveLength(6);
  });

  it('RichMetadata supports all stanceShift values', () => {
    const shifts: RichMetadata['stanceShift'][] = ['hardened', 'softened', 'unchanged'];
    expect(shifts).toHaveLength(3);
  });

  it('RichMetadata with all fields populated', () => {
    const meta: RichMetadata = {
      agentName: '花花',
      role: 'advocate',
      emotion: 'assertive',
      intensity: 0.8,
      stanceShift: 'hardened',
      replyingTo: 'binbin',
      isSystem: false,
    };
    expect(meta.intensity).toBe(0.8);
  });

  it('Adapter combines InputAdapter and OutputAdapter', () => {
    const adapter: Adapter = {
      start: async () => {},
      stop: async () => {},
      send: async () => {},
      sendSystem: async () => {},
    };
    expect(adapter.start).toBeDefined();
    expect(adapter.send).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement adapter types**

```typescript
// src/adapters/types.ts
import type { AgentRole } from '../types.js';

export interface AdapterMessage {
  content: string;
  threadId?: number;
}

export interface RichMetadata {
  agentName: string;
  role?: AgentRole;
  emotion?: 'neutral' | 'assertive' | 'questioning' | 'conceding' | 'thoughtful' | 'frustrated';
  intensity?: number;
  stanceShift?: 'hardened' | 'softened' | 'unchanged';
  replyingTo?: string;
  isSystem?: boolean;
}

export interface InputAdapter {
  start(onMessage: (msg: AdapterMessage) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface OutputAdapter {
  send(agentId: string, content: string, metadata: RichMetadata, threadId?: number): Promise<void>;
  sendSystem(content: string, threadId?: number): Promise<void>;
}

export type Adapter = InputAdapter & OutputAdapter;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/types.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run`
Expected: All 205 existing tests PASS + new tests

- [ ] **Step 6: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/adapters/types.ts tests/adapters/types.test.ts && git commit -m "feat: add adapter interface types — InputAdapter, OutputAdapter, RichMetadata"
```

---

### Task 2: Create rich metadata builder

**Files:**
- Create: `src/adapters/metadata.ts`
- Test: `tests/adapters/metadata.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/adapters/metadata.test.ts
import { describe, it, expect } from 'vitest';
import { deriveEmotion, deriveStanceShift, buildRichMetadata } from '../../src/adapters/metadata.js';
import type { AgentConfig, ResponseClassification } from '../../src/types.js';

describe('deriveEmotion', () => {
  it('returns assertive for opposition', () => {
    expect(deriveEmotion('opposition')).toBe('assertive');
  });

  it('returns thoughtful for conditional', () => {
    expect(deriveEmotion('conditional')).toBe('thoughtful');
  });

  it('returns neutral for agreement', () => {
    expect(deriveEmotion('agreement')).toBe('neutral');
  });

  it('returns neutral for undefined', () => {
    expect(deriveEmotion(undefined)).toBe('neutral');
  });
});

describe('deriveStanceShift', () => {
  it('returns softened when moving from opposition to agreement', () => {
    expect(deriveStanceShift('agreement', 'opposition')).toBe('softened');
  });

  it('returns hardened when moving from agreement to opposition', () => {
    expect(deriveStanceShift('opposition', 'agreement')).toBe('hardened');
  });

  it('returns unchanged when same classification', () => {
    expect(deriveStanceShift('opposition', 'opposition')).toBe('unchanged');
  });

  it('returns unchanged when no previous classification', () => {
    expect(deriveStanceShift('opposition', undefined)).toBe('unchanged');
  });
});

describe('buildRichMetadata', () => {
  const agents: AgentConfig[] = [
    { id: 'huahua', name: '花花', provider: 'claude', model: 'opus', memoryDir: '', personality: '' },
    { id: 'binbin', name: '賓賓', provider: 'claude', model: 'opus', memoryDir: '', personality: '' },
  ];

  it('builds metadata with agent name lookup', () => {
    const meta = buildRichMetadata('huahua', agents);
    expect(meta.agentName).toBe('花花');
  });

  it('falls back to agentId when agent not found', () => {
    const meta = buildRichMetadata('unknown', agents);
    expect(meta.agentName).toBe('unknown');
  });

  it('marks system messages', () => {
    const meta = buildRichMetadata('system', agents);
    expect(meta.isSystem).toBe(true);
  });

  it('includes role when provided', () => {
    const meta = buildRichMetadata('huahua', agents, 'opposition', undefined, 'advocate');
    expect(meta.role).toBe('advocate');
    expect(meta.emotion).toBe('assertive');
  });

  it('derives stance shift from previous classification', () => {
    const meta = buildRichMetadata('huahua', agents, 'agreement', 'opposition');
    expect(meta.stanceShift).toBe('softened');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/metadata.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement metadata builder**

```typescript
// src/adapters/metadata.ts
import type { AgentConfig, AgentRole, ResponseClassification } from '../types.js';
import type { RichMetadata } from './types.js';

export function deriveEmotion(classification?: ResponseClassification): RichMetadata['emotion'] {
  switch (classification) {
    case 'opposition': return 'assertive';
    case 'conditional': return 'thoughtful';
    case 'agreement': return 'neutral';
    default: return 'neutral';
  }
}

export function deriveStanceShift(
  current?: ResponseClassification,
  previous?: ResponseClassification,
): RichMetadata['stanceShift'] {
  if (!previous || !current || current === previous) return 'unchanged';
  if (previous === 'opposition' && current === 'agreement') return 'softened';
  if (previous === 'agreement' && current === 'opposition') return 'hardened';
  return 'unchanged';
}

export function buildRichMetadata(
  agentId: string,
  agents: AgentConfig[],
  classification?: ResponseClassification,
  previousClassification?: ResponseClassification,
  role?: AgentRole,
): RichMetadata {
  const agent = agents.find((a) => a.id === agentId);
  return {
    agentName: agent?.name ?? agentId,
    role,
    emotion: deriveEmotion(classification),
    stanceShift: deriveStanceShift(classification, previousClassification),
    isSystem: agentId === 'system',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/metadata.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/adapters/metadata.ts tests/adapters/metadata.test.ts && git commit -m "feat: add rich metadata builder — emotion + stance derivation"
```

---

## Phase 2: Telegram Adapter

### Task 3: Create TelegramAdapter

**Files:**
- Create: `src/adapters/telegram.ts`
- Test: `tests/adapters/telegram.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/adapters/telegram.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '../../src/adapters/telegram.js';
import type { AgentConfig } from '../../src/types.js';
import type { RichMetadata } from '../../src/adapters/types.js';

// Mock grammy Bot to avoid real Telegram API calls
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    api: {
      sendMessage: vi.fn().mockResolvedValue({}),
      deleteWebhook: vi.fn().mockResolvedValue(true),
      raw: { getUpdates: vi.fn().mockResolvedValue([]) },
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

const agents: AgentConfig[] = [
  { id: 'huahua', name: '花花', provider: 'claude', model: 'opus', memoryDir: '', personality: '', botTokenEnv: 'TG_HUAHUA' },
  { id: 'binbin', name: '賓賓', provider: 'claude', model: 'opus', memoryDir: '', personality: '', botTokenEnv: 'TG_BINBIN' },
];

describe('TelegramAdapter', () => {
  beforeEach(() => {
    process.env.TG_HUAHUA = 'fake-token-1';
    process.env.TG_BINBIN = 'fake-token-2';
  });

  it('implements InputAdapter and OutputAdapter', () => {
    const adapter = new TelegramAdapter({
      groupChatId: -12345,
      agents,
      listenerAgentId: 'huahua',
    });
    expect(adapter.start).toBeDefined();
    expect(adapter.stop).toBeDefined();
    expect(adapter.send).toBeDefined();
    expect(adapter.sendSystem).toBeDefined();
  });

  it('send delegates to BotManager.sendMessage', async () => {
    const adapter = new TelegramAdapter({
      groupChatId: -12345,
      agents,
      listenerAgentId: 'huahua',
    });
    const meta: RichMetadata = { agentName: '花花' };
    // send should not throw (delegates to mocked bot)
    await expect(adapter.send('huahua', 'hello', meta, 1)).resolves.not.toThrow();
  });

  it('sendSystem sends via system identity', async () => {
    const adapter = new TelegramAdapter({
      groupChatId: -12345,
      agents,
      listenerAgentId: 'huahua',
    });
    await expect(adapter.sendSystem('session ended', 1)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/telegram.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TelegramAdapter**

```typescript
// src/adapters/telegram.ts
import { BotManager } from '../telegram/bot.js';
import { createCouncilMessageFromTelegram } from '../telegram/handlers.js';
import type { AgentConfig, CouncilMessage } from '../types.js';
import type { InputAdapter, OutputAdapter, AdapterMessage, RichMetadata } from './types.js';

export interface TelegramAdapterConfig {
  groupChatId: number;
  agents: AgentConfig[];
  listenerAgentId: string;
}

export class TelegramAdapter implements InputAdapter, OutputAdapter {
  private botManager: BotManager;
  private config: TelegramAdapterConfig;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
    this.botManager = new BotManager({
      groupChatId: config.groupChatId,
      agents: config.agents,
      listenerAgentId: config.listenerAgentId,
    });
  }

  async start(onMessage: (msg: AdapterMessage) => void): Promise<void> {
    const listenerBot = this.botManager.getListenerBot();

    this.botManager.setupListener({
      handleHumanMessage: (councilMsg: CouncilMessage) => {
        onMessage({
          content: councilMsg.content,
          threadId: councilMsg.threadId,
        });
      },
    });

    await listenerBot.api.deleteWebhook({ drop_pending_updates: true });

    // Retry loop for clean polling slot
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
      onStart: () => console.log('Telegram adapter running.'),
    });
  }

  async send(agentId: string, content: string, metadata: RichMetadata, threadId?: number): Promise<void> {
    await this.botManager.sendMessage(agentId, metadata.agentName, content, threadId);
  }

  async sendSystem(content: string, threadId?: number): Promise<void> {
    await this.botManager.sendMessage('system', 'System', content, threadId);
  }

  async stop(): Promise<void> {
    const listenerBot = this.botManager.getListenerBot();
    await listenerBot.stop();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/telegram.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/adapters/telegram.ts tests/adapters/telegram.test.ts && git commit -m "feat: add TelegramAdapter — wraps BotManager as Adapter interface"
```

---

## Phase 3: CLI Adapter

### Task 4: Create CliAdapter — REPL core

**Files:**
- Create: `src/adapters/cli.ts`
- Test: `tests/adapters/cli.test.ts`

- [ ] **Step 1: Install chalk dependency**

Run: `cd /Users/imbad/Projects/agent-council && npm install chalk`

- [ ] **Step 2: Write failing test**

```typescript
// tests/adapters/cli.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliAdapter } from '../../src/adapters/cli.js';
import type { RichMetadata } from '../../src/adapters/types.js';

describe('CliAdapter', () => {
  let adapter: CliAdapter;

  beforeEach(() => {
    adapter = new CliAdapter({ verbose: false });
  });

  it('implements InputAdapter and OutputAdapter', () => {
    expect(adapter.start).toBeDefined();
    expect(adapter.stop).toBeDefined();
    expect(adapter.send).toBeDefined();
    expect(adapter.sendSystem).toBeDefined();
  });

  it('formatAgentMessage formats compact output', () => {
    const meta: RichMetadata = { agentName: '花花', role: 'advocate' };
    const result = adapter.formatAgentMessage('花花 says hi', meta);
    expect(result).toContain('花花');
    expect(result).toContain('advocate');
  });

  it('formatAgentMessage includes metadata in verbose mode', () => {
    const verboseAdapter = new CliAdapter({ verbose: true });
    const meta: RichMetadata = {
      agentName: '花花', role: 'advocate',
      emotion: 'assertive', stanceShift: 'hardened',
    };
    const result = verboseAdapter.formatAgentMessage('content', meta);
    expect(result).toContain('assertive');
    expect(result).toContain('hardened');
  });

  it('formatAgentMessage hides metadata in compact mode', () => {
    const meta: RichMetadata = {
      agentName: '花花', role: 'advocate',
      emotion: 'assertive', stanceShift: 'hardened',
    };
    const result = adapter.formatAgentMessage('content', meta);
    expect(result).not.toContain('assertive');
  });

  it('isCommand detects / prefixed input', () => {
    expect(adapter.isCommand('/help')).toBe(true);
    expect(adapter.isCommand('/quit')).toBe(true);
    expect(adapter.isCommand('hello')).toBe(false);
    expect(adapter.isCommand('/memories')).toBe(true);
  });

  it('parseCommand extracts command and args', () => {
    expect(adapter.parseCommand('/delete 3')).toEqual({ command: 'delete', args: '3' });
    expect(adapter.parseCommand('/help')).toEqual({ command: 'help', args: '' });
    expect(adapter.parseCommand('/memory principle-arch')).toEqual({ command: 'memory', args: 'principle-arch' });
  });

  it('toggleVerbose switches verbose mode', () => {
    expect(adapter.verbose).toBe(false);
    adapter.toggleVerbose();
    expect(adapter.verbose).toBe(true);
    adapter.toggleVerbose();
    expect(adapter.verbose).toBe(false);
  });

  it('sendSystem formats as gray system message', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.sendSystem('Session ended');
    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Session ended');
    writeSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/cli.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement CliAdapter**

```typescript
// src/adapters/cli.ts
import * as readline from 'node:readline';
import chalk from 'chalk';
import type { InputAdapter, OutputAdapter, AdapterMessage, RichMetadata } from './types.js';

export interface CliAdapterConfig {
  verbose: boolean;
}

const AGENT_COLORS: Record<string, (text: string) => string> = {
  huahua: chalk.cyan,
  binbin: chalk.yellow,
  facilitator: chalk.magenta,
};

export class CliAdapter implements InputAdapter, OutputAdapter {
  verbose: boolean;
  private rl: readline.Interface | null = null;
  private onMessageCallback: ((msg: AdapterMessage) => void) | null = null;

  constructor(config: CliAdapterConfig) {
    this.verbose = config.verbose;
  }

  async start(onMessage: (msg: AdapterMessage) => void): Promise<void> {
    this.onMessageCallback = onMessage;

    console.log(chalk.bold('\n═══════════════════════════════════════════'));
    console.log(chalk.bold('  Agent Council CLI v0.2.1'));
    console.log(chalk.dim('  Type /help for commands, /quit to exit'));
    console.log(chalk.bold('═══════════════════════════════════════════\n'));

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.green('You > '),
    });

    this.rl.prompt();

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }
      if (this.onMessageCallback) {
        this.onMessageCallback({ content: trimmed, threadId: 0 });
      }
      this.rl?.prompt();
    });

    this.rl.on('close', () => {
      console.log(chalk.dim('\nGoodbye.'));
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  async send(agentId: string, content: string, metadata: RichMetadata, threadId?: number): Promise<void> {
    const formatted = this.formatAgentMessage(content, metadata);
    process.stdout.write(formatted + '\n');
    this.rl?.prompt();
  }

  async sendSystem(content: string, threadId?: number): Promise<void> {
    process.stdout.write(chalk.gray(content) + '\n');
    this.rl?.prompt();
  }

  formatAgentMessage(content: string, metadata: RichMetadata): string {
    const colorFn = AGENT_COLORS[metadata.agentName] ?? AGENT_COLORS[Object.keys(AGENT_COLORS).find(k => metadata.agentName.includes(k)) ?? ''] ?? chalk.white;
    const roleTag = metadata.role ? ` [${metadata.role}]` : '';
    const header = colorFn(`${metadata.agentName}${roleTag} >`);
    const body = ` ${content}`;

    if (this.verbose && (metadata.emotion || metadata.stanceShift)) {
      const metaLine = chalk.dim(
        `  [Emotion: ${metadata.emotion ?? 'neutral'} | Stance: ${metadata.stanceShift ?? 'unchanged'}]`,
      );
      return `${header}${body}\n${metaLine}`;
    }

    return `${header}${body}`;
  }

  isCommand(input: string): boolean {
    return input.startsWith('/');
  }

  parseCommand(input: string): { command: string; args: string } {
    const spaceIdx = input.indexOf(' ');
    if (spaceIdx === -1) {
      return { command: input.slice(1), args: '' };
    }
    return { command: input.slice(1, spaceIdx), args: input.slice(spaceIdx + 1).trim() };
  }

  toggleVerbose(): void {
    this.verbose = !this.verbose;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/cli.test.ts`
Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/adapters/cli.ts tests/adapters/cli.test.ts package.json package-lock.json && git commit -m "feat: add CliAdapter — REPL core with formatting and command parsing"
```

---

### Task 5: Add CLI session persistence

**Files:**
- Create: `src/adapters/cli-sessions.ts`
- Test: `tests/adapters/cli-sessions.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/adapters/cli-sessions.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CliSessionManager } from '../../src/adapters/cli-sessions.js';
import type { CouncilMessage } from '../../src/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CliSessionManager', () => {
  let dataDir: string;
  let manager: CliSessionManager;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-sessions-'));
    manager = new CliSessionManager(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('saves a session to disk', () => {
    const history: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'hello', timestamp: Date.now() },
      { id: 'agent-1', role: 'agent', agentId: 'huahua', content: 'hi back', timestamp: Date.now() },
    ];
    manager.save('monorepo-debate', 'decision', 0.8, history);
    const sessions = manager.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].topic).toBe('monorepo-debate');
    expect(sessions[0].outcome).toBe('decision');
    expect(sessions[0].confidence).toBe(0.8);
  });

  it('lists all saved sessions sorted by date descending', () => {
    manager.save('topic-a', 'open', 0.5, []);
    manager.save('topic-b', 'decision', 0.9, []);
    const sessions = manager.list();
    expect(sessions).toHaveLength(2);
  });

  it('loads a session by index', () => {
    const history: CouncilMessage[] = [
      { id: 'msg-1', role: 'human', content: 'test', timestamp: 1000 },
    ];
    manager.save('test-topic', 'open', 0.5, history);
    const loaded = manager.load(0);
    expect(loaded).not.toBeNull();
    expect(loaded!.topic).toBe('test-topic');
    expect(loaded!.history).toHaveLength(1);
    expect(loaded!.history[0].content).toBe('test');
  });

  it('deletes a session by index', () => {
    manager.save('to-delete', 'open', 0.5, []);
    expect(manager.list()).toHaveLength(1);
    manager.delete(0);
    expect(manager.list()).toHaveLength(0);
  });

  it('returns null for invalid index', () => {
    expect(manager.load(99)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/cli-sessions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CliSessionManager**

```typescript
// src/adapters/cli-sessions.ts
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CouncilMessage } from '../types.js';

export interface SavedSession {
  topic: string;
  outcome: string;
  confidence: number;
  savedAt: string;
  history: CouncilMessage[];
}

export class CliSessionManager {
  private sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, 'sessions');
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  save(topic: string, outcome: string, confidence: number, history: CouncilMessage[]): void {
    const date = new Date().toISOString().slice(0, 10);
    const filename = `cli-${topic}-${date}.json`;
    const session: SavedSession = {
      topic,
      outcome,
      confidence,
      savedAt: new Date().toISOString(),
      history,
    };
    writeFileSync(join(this.sessionsDir, filename), JSON.stringify(session, null, 2), 'utf-8');
  }

  list(): SavedSession[] {
    if (!existsSync(this.sessionsDir)) return [];
    const files = readdirSync(this.sessionsDir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.json'))
      .sort()
      .reverse();
    return files.map((f) => {
      const content = readFileSync(join(this.sessionsDir, f), 'utf-8');
      return JSON.parse(content) as SavedSession;
    });
  }

  load(index: number): SavedSession | null {
    const files = readdirSync(this.sessionsDir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (index < 0 || index >= files.length) return null;
    const content = readFileSync(join(this.sessionsDir, files[index]), 'utf-8');
    return JSON.parse(content) as SavedSession;
  }

  delete(index: number): boolean {
    const files = readdirSync(this.sessionsDir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (index < 0 || index >= files.length) return false;
    unlinkSync(join(this.sessionsDir, files[index]));
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/cli-sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/adapters/cli-sessions.ts tests/adapters/cli-sessions.test.ts && git commit -m "feat: add CliSessionManager — save, list, load, delete CLI sessions"
```

---

### Task 6: Add CLI command handler

**Files:**
- Create: `src/adapters/cli-commands.ts`
- Test: `tests/adapters/cli-commands.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/adapters/cli-commands.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliCommandHandler } from '../../src/adapters/cli-commands.js';
import { CliSessionManager } from '../../src/adapters/cli-sessions.js';
import { MemoryDB } from '../../src/memory/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CliCommandHandler', () => {
  let dataDir: string;
  let sessionManager: CliSessionManager;
  let memoryDb: MemoryDB;
  let handler: CliCommandHandler;
  let outputLines: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-cmd-'));
    sessionManager = new CliSessionManager(dataDir);
    memoryDb = new MemoryDB(':memory:');
    outputLines = [];
    handler = new CliCommandHandler(sessionManager, memoryDb, (line) => outputLines.push(line));
  });

  afterEach(() => {
    memoryDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('handles /help command', () => {
    handler.handle('help', '');
    expect(outputLines.some((l) => l.includes('/help'))).toBe(true);
    expect(outputLines.some((l) => l.includes('/quit'))).toBe(true);
  });

  it('handles /sessions with no saved sessions', () => {
    handler.handle('sessions', '');
    expect(outputLines.some((l) => l.includes('No saved sessions'))).toBe(true);
  });

  it('handles /sessions with saved sessions', () => {
    sessionManager.save('test-topic', 'decision', 0.8, []);
    handler.handle('sessions', '');
    expect(outputLines.some((l) => l.includes('test-topic'))).toBe(true);
  });

  it('handles /memories with no memories', () => {
    handler.handle('memories', '');
    expect(outputLines.some((l) => l.includes('No active'))).toBe(true);
  });

  it('handles /memories with inserted memories', () => {
    memoryDb.insertMemory({
      id: 'principle-test', agentId: 'huahua', type: 'principle',
      topic: 'testing', confidence: 0.9, outcome: 'decision',
      usageCount: 3, lastUsed: '2026-04-13', createdAt: '2026-04-10',
      contentPreview: 'Always write integration tests',
    });
    handler.handle('memories', '');
    expect(outputLines.some((l) => l.includes('principle-test'))).toBe(true);
  });

  it('handles /delete with valid index', () => {
    sessionManager.save('deleteme', 'open', 0.5, []);
    handler.handle('delete', '1');
    expect(sessionManager.list()).toHaveLength(0);
    expect(outputLines.some((l) => l.includes('Deleted'))).toBe(true);
  });

  it('handles /delete with invalid index', () => {
    handler.handle('delete', '99');
    expect(outputLines.some((l) => l.includes('Invalid'))).toBe(true);
  });

  it('handles unknown command', () => {
    handler.handle('foobar', '');
    expect(outputLines.some((l) => l.includes('Unknown'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/cli-commands.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CliCommandHandler**

```typescript
// src/adapters/cli-commands.ts
import type { CliSessionManager, SavedSession } from './cli-sessions.js';
import type { MemoryDB } from '../memory/db.js';

type PrintFn = (line: string) => void;

export class CliCommandHandler {
  private sessions: CliSessionManager;
  private db: MemoryDB;
  private print: PrintFn;

  constructor(sessions: CliSessionManager, db: MemoryDB, print: PrintFn) {
    this.sessions = sessions;
    this.db = db;
    this.print = print;
  }

  handle(command: string, args: string): void {
    switch (command) {
      case 'help': return this.help();
      case 'sessions': return this.listSessions();
      case 'delete': return this.deleteSession(args);
      case 'memories': return this.listMemories();
      case 'memory': return this.showMemory(args);
      case 'forget': return this.forgetMemory(args);
      case 'patterns': return this.listPatterns();
      default:
        this.print(`Unknown command: /${command}. Type /help for available commands.`);
    }
  }

  private help(): void {
    this.print('Available commands:');
    this.print('  /help        — Show this help');
    this.print('  /debug       — Toggle verbose mode');
    this.print('  /quit        — End session (prompts to save)');
    this.print('  /sessions    — List saved sessions');
    this.print('  /resume      — Resume a saved session');
    this.print('  /delete <n>  — Delete saved session by number');
    this.print('  /memories    — List active principles + rules');
    this.print('  /memory <id> — Show full memory content');
    this.print('  /forget <id> — Archive a memory');
    this.print('  /patterns    — List behavioral patterns');
  }

  private listSessions(): void {
    const sessions = this.sessions.list();
    if (sessions.length === 0) {
      this.print('No saved sessions.');
      return;
    }
    this.print('Saved sessions:');
    sessions.forEach((s, i) => {
      this.print(`  ${i + 1}. ${s.topic} (${s.savedAt.slice(0, 10)}) — ${s.outcome}, confidence ${s.confidence}`);
    });
  }

  private deleteSession(args: string): void {
    const idx = parseInt(args, 10) - 1;
    if (isNaN(idx) || idx < 0) {
      this.print('Invalid index. Usage: /delete <number>');
      return;
    }
    if (this.sessions.delete(idx)) {
      this.print('Deleted.');
    } else {
      this.print('Invalid index — session not found.');
    }
  }

  private listMemories(): void {
    const principles = this.db.listMemories('', 'principle');
    const rules = this.db.listMemories('', 'rule');
    const all = [...principles, ...rules];
    if (all.length === 0) {
      this.print('No active principles or rules.');
      return;
    }
    this.print('Active memories:');
    for (const m of all) {
      this.print(`  [${m.type}] ${m.id} — ${m.contentPreview.slice(0, 80)} (confidence: ${m.confidence})`);
    }
  }

  private showMemory(id: string): void {
    if (!id) {
      this.print('Usage: /memory <id>');
      return;
    }
    const record = this.db.getMemory(id);
    if (!record) {
      this.print(`Memory not found: ${id}`);
      return;
    }
    this.print(`ID: ${record.id}`);
    this.print(`Type: ${record.type}`);
    this.print(`Topic: ${record.topic ?? 'none'}`);
    this.print(`Confidence: ${record.confidence}`);
    this.print(`Outcome: ${record.outcome ?? 'none'}`);
    this.print(`Usage: ${record.usageCount} times`);
    this.print(`Content: ${record.contentPreview}`);
  }

  private forgetMemory(id: string): void {
    if (!id) {
      this.print('Usage: /forget <id>');
      return;
    }
    const record = this.db.getMemory(id);
    if (!record) {
      this.print(`Memory not found: ${id}`);
      return;
    }
    this.db.updateType(id, 'archive');
    this.print(`Archived: ${id}`);
  }

  private listPatterns(): void {
    const patterns = this.db.getPatterns('');
    if (patterns.length === 0) {
      this.print('No behavioral patterns recorded.');
      return;
    }
    this.print('Behavioral patterns:');
    for (const p of patterns) {
      this.print(`  [${p.agentId}/${p.topic}] ${p.behavior}`);
    }
  }
}
```

Note: `this.db.listMemories('', 'principle')` passes empty string for agentId to get all agents' memories. The existing `listMemories` method filters by agentId — if empty string returns nothing, the implementer should check the DB method and adjust (pass each known agentId, or modify the query). The `getPatterns('')` has the same consideration.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/cli-commands.test.ts`
Expected: PASS (may need to adjust DB queries if empty agentId doesn't work — see note above)

- [ ] **Step 5: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/adapters/cli-commands.ts tests/adapters/cli-commands.test.ts && git commit -m "feat: add CliCommandHandler — /help, /sessions, /memories, /forget, /patterns"
```

---

## Phase 4: Adapter Factory + index.ts Wiring

### Task 7: Create Adapter Factory

**Files:**
- Create: `src/adapters/factory.ts`
- Test: `tests/adapters/factory.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/adapters/factory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdapter, parseArgs } from '../../src/adapters/factory.js';

// Mock grammy for TelegramAdapter
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    api: { sendMessage: vi.fn(), deleteWebhook: vi.fn(), raw: { getUpdates: vi.fn() } },
    start: vi.fn(), stop: vi.fn(),
  })),
}));

describe('parseArgs', () => {
  it('parses --adapter flag', () => {
    const args = parseArgs(['--adapter=cli']);
    expect(args.adapter).toBe('cli');
  });

  it('defaults adapter to telegram', () => {
    const args = parseArgs([]);
    expect(args.adapter).toBe('telegram');
  });

  it('parses --verbose flag', () => {
    const args = parseArgs(['--verbose']);
    expect(args.verbose).toBe(true);
  });

  it('parses positional message for single-shot', () => {
    const args = parseArgs(['--adapter=cli', '我們該用 monorepo 嗎？']);
    expect(args.message).toBe('我們該用 monorepo 嗎？');
  });

  it('defaults verbose to false', () => {
    const args = parseArgs([]);
    expect(args.verbose).toBe(false);
  });
});

describe('createAdapter', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'fake';
  });

  it('creates CliAdapter for cli', () => {
    const adapter = createAdapter('cli', {
      cli: { verbose: false },
      telegram: { groupChatId: 0, agents: [], listenerAgentId: '' },
    });
    expect(adapter.start).toBeDefined();
    expect(adapter.send).toBeDefined();
  });

  it('creates TelegramAdapter for telegram', () => {
    const adapter = createAdapter('telegram', {
      cli: { verbose: false },
      telegram: { groupChatId: -123, agents: [], listenerAgentId: '' },
    });
    expect(adapter.start).toBeDefined();
  });

  it('throws for unknown adapter', () => {
    expect(() => createAdapter('discord', {
      cli: { verbose: false },
      telegram: { groupChatId: 0, agents: [], listenerAgentId: '' },
    })).toThrow('Unknown adapter');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/factory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement factory + parseArgs**

```typescript
// src/adapters/factory.ts
import { CliAdapter, type CliAdapterConfig } from './cli.js';
import { TelegramAdapter, type TelegramAdapterConfig } from './telegram.js';
import type { Adapter } from './types.js';

export interface AdapterFactoryConfig {
  cli: CliAdapterConfig;
  telegram: TelegramAdapterConfig;
}

export interface ParsedArgs {
  adapter: string;
  verbose: boolean;
  message?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let adapter = 'telegram';
  let verbose = false;
  let message: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--adapter=')) {
      adapter = arg.slice('--adapter='.length);
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (!arg.startsWith('--')) {
      message = arg;
    }
  }

  return { adapter, verbose, message };
}

export function createAdapter(name: string, config: AdapterFactoryConfig): Adapter {
  switch (name) {
    case 'cli':
      return new CliAdapter(config.cli);
    case 'telegram':
      return new TelegramAdapter(config.telegram);
    default:
      throw new Error(`Unknown adapter: ${name}. Available: telegram, cli`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/adapters/factory.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/adapters/factory.ts tests/adapters/factory.test.ts && git commit -m "feat: add adapter factory + CLI arg parser"
```

---

### Task 8: Rewrite index.ts for adapter-based wiring

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json` (add cli script)

- [ ] **Step 1: Rewrite index.ts**

Key changes:
1. Import `parseArgs`, `createAdapter` from adapters/factory
2. Import `buildRichMetadata` from adapters/metadata
3. Parse CLI args at start
4. Build adapter config and create adapter
5. Replace direct BotManager usage with adapter.send/sendSystem
6. Replace bot startup with adapter.start
7. Track per-agent previous classifications for stance shift metadata
8. Add `npm run cli` script to package.json

The sendFn wrapping changes from:
```typescript
const agentName = agentNameMap.get(agentId) ?? agentId;
await botManager.sendMessage(agentId, agentName, content, threadId);
```

To:
```typescript
const metadata = buildRichMetadata(agentId, agentConfigs);
await adapter.send(agentId, content, metadata, threadId);
```

For system messages, use `adapter.sendSystem(content, threadId)`.

The adapter.start replaces the entire Telegram polling setup at the bottom of main().

- [ ] **Step 2: Add cli scripts to package.json**

```json
"cli": "node dist/index.js --adapter=cli",
"cli:verbose": "node dist/index.js --adapter=cli --verbose"
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/imbad/Projects/agent-council && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add src/index.ts package.json && git commit -m "feat: wire adapter factory in index.ts — support --adapter=cli flag"
```

---

## Phase 5: Integration + Verification

### Task 9: Integration test — CLI adapter event flow

**Files:**
- Create: `tests/integration/cli-flow.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration/cli-flow.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliAdapter } from '../../src/adapters/cli.js';
import type { RichMetadata } from '../../src/adapters/types.js';

describe('CLI Adapter Integration', () => {
  it('formatAgentMessage handles all agent colors', () => {
    const adapter = new CliAdapter({ verbose: false });

    const huahuaMeta: RichMetadata = { agentName: '花花', role: 'advocate' };
    const binbinMeta: RichMetadata = { agentName: '賓賓', role: 'critic' };
    const facilitatorMeta: RichMetadata = { agentName: '主持人' };

    const h = adapter.formatAgentMessage('test', huahuaMeta);
    const b = adapter.formatAgentMessage('test', binbinMeta);
    const f = adapter.formatAgentMessage('test', facilitatorMeta);

    expect(h).toContain('花花');
    expect(h).toContain('advocate');
    expect(b).toContain('賓賓');
    expect(f).toContain('主持人');
  });

  it('system messages are formatted', async () => {
    const adapter = new CliAdapter({ verbose: false });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await adapter.sendSystem('Session ended: monorepo-debate');

    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Session ended');
    writeSpy.mockRestore();
  });

  it('verbose mode shows metadata, compact hides it', () => {
    const compactAdapter = new CliAdapter({ verbose: false });
    const verboseAdapter = new CliAdapter({ verbose: true });

    const meta: RichMetadata = {
      agentName: '花花', role: 'advocate',
      emotion: 'assertive', stanceShift: 'hardened',
    };

    const compact = compactAdapter.formatAgentMessage('content', meta);
    const verbose = verboseAdapter.formatAgentMessage('content', meta);

    expect(compact).not.toContain('assertive');
    expect(verbose).toContain('assertive');
    expect(verbose).toContain('hardened');
  });

  it('command parsing works for all commands', () => {
    const adapter = new CliAdapter({ verbose: false });

    expect(adapter.isCommand('/sessions')).toBe(true);
    expect(adapter.isCommand('/memory principle-arch')).toBe(true);
    expect(adapter.isCommand('normal message')).toBe(false);

    expect(adapter.parseCommand('/delete 3')).toEqual({ command: 'delete', args: '3' });
    expect(adapter.parseCommand('/quit')).toEqual({ command: 'quit', args: '' });
    expect(adapter.parseCommand('/memory some-long-id')).toEqual({ command: 'memory', args: 'some-long-id' });
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run tests/integration/cli-flow.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add tests/integration/cli-flow.test.ts && git commit -m "test: add CLI adapter integration tests"
```

---

### Task 10: Final verification + version bump

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/imbad/Projects/agent-council && npx vitest run`
Expected: All PASS

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/imbad/Projects/agent-council && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Bump version to 0.2.1**

In `package.json`, change `"version": "0.2.0"` to `"version": "0.2.1"`.

- [ ] **Step 4: Commit**

```bash
cd /Users/imbad/Projects/agent-council && git add package.json && git commit -m "chore: bump version to 0.2.1"
```
