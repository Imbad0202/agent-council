# Agent Council — Adapter Layer + CLI Adapter Design

**Date:** 2026-04-13
**Status:** Approved
**Target:** v0.2.1

## Summary

Decouple agent-council's core engine from Telegram transport. Introduce InputAdapter/OutputAdapter interfaces with rich metadata support, refactor Telegram into TelegramAdapter, and add a new CLI adapter with REPL + single-shot modes, session persistence, and memory management commands.

## Design Decisions

| Decision | Choice | Alternatives Rejected |
|----------|--------|-----------------------|
| Architecture | Adapter Interface + Factory | Dual entry point, plugin system |
| CLI modes | REPL + single-shot | REPL only |
| Display verbosity | Switchable (default compact, --verbose/debug) | Full only, compact only |
| Rich metadata | Include now (emotion/stance/intensity) | Defer, minimal |
| Telegram refactor | Yes, wrap in TelegramAdapter | Leave as-is |
| Adapter selection | CLI flag (--adapter=cli) | Config-driven, separate entry point |
| Multi-adapter | Independent sessions per adapter | Shared session |
| Session persistence | User chooses save/discard on quit | Auto-save, no persistence |
| Memory management | CLI / commands | No management |

---

## 1. Adapter Interfaces

**New file:** `src/adapters/types.ts`

### AdapterMessage

```typescript
interface AdapterMessage {
  content: string;
  threadId?: number;
}
```

### RichMetadata

Carries visual/behavioral metadata derived from the deliberation process. CLI uses it for coloring; future game adapters use it for character animation.

```typescript
interface RichMetadata {
  agentName: string;
  role?: AgentRole;
  emotion?: 'neutral' | 'assertive' | 'questioning' | 'conceding' | 'thoughtful' | 'frustrated';
  intensity?: number;          // 0.0-1.0
  stanceShift?: 'hardened' | 'softened' | 'unchanged';
  replyingTo?: string;         // agentId being responded to
  isSystem?: boolean;
}
```

Emotion derivation (from anti-sycophancy classification):
- `opposition` + high intensity → `assertive`
- `opposition` + low intensity → `questioning`
- `conditional` → `thoughtful`
- `agreement` after prior opposition → `conceding`
- default → `neutral`

Stance shift derivation (comparing current vs previous classification for same agent):
- was `opposition`, now `agreement` → `softened`
- was `agreement`, now `opposition` → `hardened`
- same → `unchanged`

### InputAdapter

```typescript
interface InputAdapter {
  start(onMessage: (msg: AdapterMessage) => void): Promise<void>;
  stop(): Promise<void>;
}
```

### OutputAdapter

```typescript
interface OutputAdapter {
  send(agentId: string, content: string, metadata: RichMetadata, threadId?: number): Promise<void>;
  sendSystem(content: string, threadId?: number): Promise<void>;
}
```

### Combined type for convenience

```typescript
type Adapter = InputAdapter & OutputAdapter;
```

---

## 2. CLI Adapter

**New file:** `src/adapters/cli.ts`
**New dependency:** `chalk` (terminal colors)

### REPL Mode (default)

Starts when no positional argument is provided and stdin is a TTY.

**Startup:**
```
═══════════════════════════════════════════
  Agent Council CLI v0.2.1
  Agents: 花花 (claude-opus-4-7), 賓賓 (claude-opus-4-7)
  Facilitator: 主持人 (claude-sonnet-4-6)
  Type /help for commands, /quit to exit
═══════════════════════════════════════════

You > 
```

**Agent response format (compact):**
```
花花 [advocate] > I think we should use monorepo because...
賓賓 [critic] > However, the dependency management...
主持人 > 雙方論點都有道理。花花，你還沒回應賓賓關於...
```

**Agent response format (verbose, via --verbose or /debug):**
```
[Intent: deliberation | Complexity: medium]
[Roles: huahua=advocate, binbin=critic]

花花 [advocate] > I think we should use monorepo because...
  [Classification: opposition | Emotion: assertive | Stance: hardened]

賓賓 [critic] > However, the dependency management...
  [Classification: conditional | Emotion: thoughtful | Stance: unchanged]
  [Memory injected: ref:principle-architecture.md]

主持人 > 雙方論點都有道理。
  [Action: steer]
```

**Colors:**
- 花花: cyan
- 賓賓: yellow
- 主持人: magenta
- System: gray
- Human input: white (default)
- Verbose metadata: dim/gray

### Single-Shot Mode

Triggered when positional argument is provided or stdin is not a TTY.

```bash
# Positional argument
node dist/index.js --adapter=cli "我們該用 monorepo 嗎？"

# Piped input
echo "我們該用 monorepo 嗎？" | node dist/index.js --adapter=cli
```

Prints all agent responses, then exits. No session save prompt.

### CLI Commands (REPL mode)

| Command | Description |
|---------|-------------|
| `/help` | List available commands |
| `/debug` | Toggle verbose mode |
| `/quit` | End session (prompts to save) |
| `/sessions` | List saved sessions |
| `/resume` | List saved sessions and resume one |
| `/delete <n>` | Delete saved session by number |
| `/memories` | List active principles + rules |
| `/memory <id>` | Show full memory content |
| `/forget <id>` | Archive a memory |
| `/patterns` | List behavioral patterns |

Commands are intercepted by the CLI adapter before reaching the EventBus. They are NOT sent as `message.received`.

### Session Persistence

**On quit (/quit or Ctrl+C):**
```
Save this session? (y/n): y
Session saved: monorepo-debate (2026-04-13)
```

**Storage format:** `data/sessions/cli-{topic}-{date}.json`
```json
{
  "topic": "monorepo-debate",
  "outcome": "decision",
  "confidence": 0.8,
  "savedAt": "2026-04-13T15:30:00Z",
  "history": [
    { "id": "msg-1", "role": "human", "content": "...", "timestamp": 1234567890 },
    { "id": "agent-huahua-1234", "role": "agent", "agentId": "huahua", "content": "...", "timestamp": 1234567891 }
  ]
}
```

**On resume:**
```
Saved sessions:
  1. monorepo-debate (2026-04-13) — decision, confidence 0.8
  2. api-design (2026-04-12) — open, confidence 0.5

Resume which? (number or 'new'): 1
Resuming monorepo-debate...
[Previous discussion loaded: 5 messages]

You > 
```

Resume loads history into DeliberationHandler's session state. CLI uses a fixed threadId of `0` for all sessions (only one concurrent session in CLI mode). On resume, the previous history is injected into the session for threadId `0`.

---

## 3. Telegram Adapter

**New file:** `src/adapters/telegram.ts`

Wraps existing `BotManager` and `handlers.ts` logic.

```typescript
class TelegramAdapter implements InputAdapter, OutputAdapter {
  private botManager: BotManager;
  private listenerBot: Bot;

  constructor(config: TelegramAdapterConfig) {
    this.botManager = new BotManager(config);
  }

  async start(onMessage): Promise<void> {
    // Setup listener on listenerBot
    // deleteWebhook + getUpdates retry loop
    // bot.start()
  }

  async send(agentId, content, metadata, threadId): Promise<void> {
    const agentName = metadata.agentName;
    await this.botManager.sendMessage(agentId, agentName, content, threadId);
    // metadata (emotion, stance) ignored — Telegram uses bot identity
  }

  async sendSystem(content, threadId): Promise<void> {
    await this.botManager.sendMessage('system', 'System', content, threadId);
  }

  async stop(): Promise<void> {
    await this.listenerBot.stop();
  }
}
```

**Existing files kept (used internally by TelegramAdapter):**
- `src/telegram/bot.ts` — BotManager unchanged
- `src/telegram/handlers.ts` — createCouncilMessageFromTelegram unchanged

**Config type:**
```typescript
interface TelegramAdapterConfig {
  groupChatId: number;
  agents: AgentConfig[];
  listenerAgentId: string;
}
```

---

## 4. Adapter Factory

**New file:** `src/adapters/factory.ts`

```typescript
function createAdapter(name: string, config: AdapterFactoryConfig): Adapter {
  switch (name) {
    case 'telegram':
      return new TelegramAdapter(config.telegram);
    case 'cli':
      return new CliAdapter(config.cli);
    default:
      throw new Error(`Unknown adapter: ${name}. Available: telegram, cli`);
  }
}
```

---

## 5. index.ts Changes

### CLI Argument Parsing

Simple `process.argv` parsing (no external dependency):

```typescript
const args = parseArgs(process.argv.slice(2));
// args.adapter: string (default 'telegram')
// args.verbose: boolean
// args.message: string | undefined (positional, for single-shot)
```

### Wiring Changes

```typescript
// Before: direct BotManager usage
const botManager = new BotManager({...});
const sendFn = async (agentId, content, threadId) => {...};

// After: adapter-based
const adapter = createAdapter(args.adapter, adapterConfig);
const sendFn = async (agentId, content, threadId) => {
  const metadata = buildRichMetadata(agentId, agentConfigs);
  await adapter.send(agentId, content, metadata, threadId);
};

// Start
adapter.start((msg) => router.handleHumanMessage({
  id: `${args.adapter}-${Date.now()}`,
  role: 'human',
  content: msg.content,
  timestamp: Date.now(),
  threadId: msg.threadId ?? 0,
}));
```

### package.json

```json
{
  "scripts": {
    "cli": "node dist/index.js --adapter=cli",
    "cli:verbose": "node dist/index.js --adapter=cli --verbose"
  },
  "dependencies": {
    "chalk": "^5.4.0"
  }
}
```

---

## 6. File Structure

```
src/adapters/
├── types.ts          # InputAdapter, OutputAdapter, RichMetadata, Adapter
├── factory.ts        # createAdapter()
├── cli.ts            # CliAdapter — REPL + single-shot + / commands
└── telegram.ts       # TelegramAdapter — wraps BotManager

src/telegram/
├── bot.ts            # BotManager — UNCHANGED (used by TelegramAdapter)
└── handlers.ts       # UNCHANGED (used by TelegramAdapter)

src/index.ts          # MODIFIED — adapter-based wiring + arg parsing
```

---

## 7. Rich Metadata Generation

**New file or addition to deliberation.ts:** `buildRichMetadata()` function.

Called by the sendFn wrapper in index.ts. Derives emotion and stance from the EventBus events:

```typescript
function buildRichMetadata(
  agentId: string,
  agentConfigs: AgentConfig[],
  classification?: ResponseClassification,
  previousClassification?: ResponseClassification,
  role?: AgentRole,
): RichMetadata {
  const agent = agentConfigs.find(a => a.id === agentId);
  return {
    agentName: agent?.name ?? agentId,
    role,
    emotion: deriveEmotion(classification),
    stanceShift: deriveStanceShift(classification, previousClassification),
    isSystem: agentId === 'system',
  };
}
```

This requires tracking previous classifications per agent per session. The DeliberationHandler already tracks classifications in AntiSycophancyEngine — extend it to expose per-agent last classification.

---

## 8. Testing Strategy

- **Adapter interface tests:** Verify CliAdapter and TelegramAdapter implement the interface correctly
- **CLI REPL tests:** Mock readline, verify command dispatch, response formatting
- **CLI single-shot tests:** Verify exit after responses
- **CLI session persistence tests:** Save/load/delete/resume
- **CLI command tests:** Each / command
- **Telegram adapter tests:** Verify delegation to BotManager
- **Factory tests:** Correct adapter created for each name
- **Integration test:** Wire CLI adapter → EventBus → mock workers → verify output
- **Rich metadata tests:** Verify emotion/stance derivation from classification
