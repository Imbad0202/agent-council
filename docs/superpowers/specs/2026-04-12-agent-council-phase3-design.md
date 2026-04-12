# Agent Council Phase 3 — Multi-Model, Multi-Bot, Dynamic Participation

**Date:** 2026-04-12
**Author:** 吳政宜 + 花花 (Claude Opus 4.6)
**Status:** Draft — pending user review
**Prerequisite:** Phase 1 + Phase 2 complete (33 commits, 79 tests)

---

## 1. Overview

**Goal:** Support multiple LLM providers, independent Telegram bots per agent, dynamic agent participation with mid-session recruitment, and per-thread session isolation in supergroup forums.

**Decisions made during brainstorm:**

| Decision | Choice |
|----------|--------|
| Multi-model providers | OpenAI + Google + Custom (any OpenAI-compatible API) |
| Bot architecture | One bot per agent (independent identity) |
| Supergroup topics | Mixed mode (follow thread, don't auto-create) |
| Agent participation | Dynamic per-turn, max 3, mid-session recruitment |
| Priority | All at once |

---

## 2. Multi-Bot Architecture

### 2.1 One Bot Per Agent

Each agent has its own Telegram bot with independent name, avatar, and token.

**Agent config addition (`bot_token_env` field):**

```yaml
id: huahua
name: 花花
provider: claude
model: claude-opus-4-6
bot_token_env: TELEGRAM_BOT_TOKEN_HUAHUA
topics: [architecture, code, strategy, general]
memory_dir: 花花/global
personality: |
  你是花花...
```

**Environment variables:**

```bash
TELEGRAM_BOT_TOKEN_HUAHUA=token-for-huahua-bot
TELEGRAM_BOT_TOKEN_BINBIN=token-for-binbin-bot
TELEGRAM_BOT_TOKEN_GEMINI=token-for-gemini-bot
TELEGRAM_GROUP_CHAT_ID=-1003880687499
```

### 2.2 Listener vs Sender Pattern

Only one bot does long-polling (receives messages). All bots can send messages.

- **Listener bot:** Specified in `council.yaml` as `participation.listener_agent`. Defaults to the first agent in config if not set. This bot's `Bot` instance calls `bot.start()` with polling.
- **Sender bots:** All other agents' bots are initialized as `Bot` instances but never poll. They only call `bot.api.sendMessage()` to post responses.

This avoids the Telegram 409 conflict (only one getUpdates connection per bot token).

**Message flow:**

```
Human sends message in thread X
  → Listener bot receives via polling
  → Gateway routes to session for thread X
  → Gateway selects participating agents
  → Each agent's own bot sends their response to thread X
```

### 2.3 Bot Initialization

```typescript
// Per-agent bot map
const agentBots: Map<string, Bot> = new Map();

for (const config of agentConfigs) {
  const token = process.env[config.botTokenEnv];
  if (token) {
    agentBots.set(config.id, new Bot(token));
  }
}

// Only listener bot polls
const listenerBot = agentBots.get(councilConfig.participation.listenerAgent);
```

---

## 3. Multi-Model Providers

### 3.1 Provider Factory

```typescript
function createProvider(providerName: string): LLMProvider {
  switch (providerName) {
    case 'claude': return new ClaudeProvider(process.env.ANTHROPIC_API_KEY!);
    case 'openai': return new OpenAIProvider(process.env.OPENAI_API_KEY!);
    case 'google': return new GoogleProvider(process.env.GOOGLE_AI_API_KEY!);
    case 'custom': return new CustomProvider(
      process.env.CUSTOM_PROVIDER_URL!,
      process.env.CUSTOM_PROVIDER_API_KEY,
    );
    default: throw new Error(`Unknown provider: ${providerName}`);
  }
}
```

Each agent can use a different provider. The provider is determined by the `provider` field in the agent's YAML config.

### 3.2 OpenAIProvider

Uses `openai` npm package. Maps to `LLMProvider` interface:

- `chat()` → `client.chat.completions.create({ model, messages, max_tokens, temperature })`
- `summarize()` → same as `chat()` with summarization system prompt
- `estimateTokens()` → character-based estimate (~4 chars/token for English)
- Maps `system` role to first message with `role: 'system'`

### 3.3 GoogleProvider

Uses `@google/genai` npm package. Maps to `LLMProvider` interface:

- `chat()` → `client.models.generateContent({ model, contents, systemInstruction })`
- Google API uses `user`/`model` roles instead of `user`/`assistant`
- System prompt passed as `systemInstruction` parameter

### 3.4 CustomProvider

Generic HTTP POST provider for OpenAI-compatible APIs (Ollama, Together, Groq, etc.):

- Constructor takes `baseUrl` and optional `apiKey`
- `chat()` → POST to `${baseUrl}/chat/completions` with OpenAI-compatible JSON body
- Parses standard `choices[0].message.content` response format
- Works with any API that follows the OpenAI chat completions spec

### 3.5 Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Optional — only needed if agents use these providers
OPENAI_API_KEY=sk-...
GOOGLE_AI_API_KEY=AI...
CUSTOM_PROVIDER_URL=http://localhost:11434/v1
CUSTOM_PROVIDER_API_KEY=...
```

---

## 4. Dynamic Participation + Mid-Session Recruitment

### 4.1 Agent Topics

Each agent declares topics they're good at:

```yaml
id: huahua
topics: [architecture, code, strategy, general]

id: binbin
topics: [code, risk, testing, general]

id: gemini
topics: [research, data, analysis, literature]
```

`general` = participates in any discussion. Agents without `topics` field default to `[general]`.

### 4.2 Participation Selection (Per Turn)

Every time a human message arrives:

1. Detect topic keywords from the message (reuse existing `detectTopic()`)
2. Score each registered agent: number of matching topics
3. Select top N agents (max `participation.max_agents_per_turn`, default 3)
4. If fewer than `participation.min_agents_per_turn` (default 2) match → fill with `general` agents
5. Always ensure at least 2 participants

### 4.3 Mid-Session Recruitment

Compare current session participants vs. optimal participants for this turn:

- **New agent should join:** Topic shifted to a domain where a non-participating agent is more relevant
  - Action: Add agent to session, send group message: `🔄 [Agent Name] 加入了這場討論`
  - New agent receives compressed conversation history (from context health monitor)

- **Agent should leave:** Agent's topics are completely irrelevant to current discussion AND agent has been silent (skipped) for 3+ consecutive turns
  - Action: Remove from session, send group message: `👋 [Agent Name] 退出了這場討論`

- **Human override:** Human can mention `@botname 加入` or `@botname 退出` to force participation changes

### 4.4 Cost Control

- Hard cap: `max_agents_per_turn` (default 3) agents respond per turn
- If 5 agents all match the topic, only top 3 by relevance score respond
- Agents that skip (`{ skip: true }`) don't count toward the cap

---

## 5. Supergroup Topic Thread Support

### 5.1 Mixed Mode Behavior

| User action | Bot behavior |
|-------------|-------------|
| Send message in General | Respond in General |
| Send message in a topic thread | Respond in that same topic thread |
| Create a new topic thread and message there | Respond in the new thread |

Bots never create topic threads. They follow the human.

### 5.2 Per-Thread Session Isolation

Each `message_thread_id` gets its own session state:

```typescript
interface SessionState {
  conversationHistory: CouncilMessage[];
  currentParticipants: string[];
  turnCount: number;
  antiSycophancy: AntiSycophancyEngine;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

// Router maintains a map of sessions
private sessions: Map<number, SessionState> = new Map();
```

- `thread_id = 0` or `undefined` → General session
- Each session has independent conversation history, turn count, anti-sycophancy state, and inactivity timer
- Session lifecycle (end keywords, timeout, max turns) operates per-thread
- brain.db stores `thread_id` in memory records for traceability

### 5.3 Thread ID in Messages

`CouncilMessage` gains an optional `threadId` field:

```typescript
interface CouncilMessage {
  // ... existing fields
  threadId?: number;  // Telegram message_thread_id
}
```

---

## 6. Configuration

### 6.1 Updated council.yaml

```yaml
gateway:
  thinking_window_ms: 5000
  random_delay_ms: [1000, 3000]
  max_inter_agent_rounds: 3
  context_window_turns: 10
  session_max_turns: 20

anti_sycophancy:
  disagreement_threshold: 0.2
  consecutive_low_rounds: 3
  challenge_angles: [cost, risk, alternatives, long-term impact, scalability, maintainability]

roles:
  default_2_agents: [advocate, critic]
  topic_overrides:
    code: [author, reviewer]
    strategy: [advocate, critic]

memory:
  db_path: data/brain.db
  session_timeout_ms: 600000
  end_keywords: ["結束", "done", "結論", "wrap up", "總結"]
  archive_threshold: 30
  archive_bottom_percent: 20
  consolidation_threshold: 5

anti_pattern:
  enabled: true
  detection_model: claude-haiku-4-5-20251001
  start_after_turn: 3
  detect_every_n_turns: 2

participation:
  max_agents_per_turn: 3
  min_agents_per_turn: 2
  recruitment_message: true
  listener_agent: huahua
```

### 6.2 Updated Agent Config

```yaml
id: huahua
name: 花花
provider: claude
model: claude-opus-4-6
bot_token_env: TELEGRAM_BOT_TOKEN_HUAHUA
topics: [architecture, code, strategy, general]
memory_dir: 花花/global
personality: |
  你是花花...
```

New fields: `bot_token_env` (required for multi-bot), `topics` (optional, defaults to `[general]`).

### 6.3 Updated .env.example

```bash
# Telegram Bot Tokens (one per agent)
TELEGRAM_BOT_TOKEN_HUAHUA=your-bot-token
TELEGRAM_BOT_TOKEN_BINBIN=your-bot-token
# TELEGRAM_BOT_TOKEN_GEMINI=your-bot-token

# Telegram Group Chat ID
TELEGRAM_GROUP_CHAT_ID=-1003880687499

# LLM Provider API Keys (only needed for providers you use)
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# GOOGLE_AI_API_KEY=AI...

# Custom Provider (OpenAI-compatible, e.g., Ollama)
# CUSTOM_PROVIDER_URL=http://localhost:11434/v1
# CUSTOM_PROVIDER_API_KEY=...

# External memory (optional)
# MEMORY_SYNC_PATH=/path/to/claude-memory-sync
```

---

## 7. Files to Create or Modify

### New files:

- `src/worker/providers/openai.ts` — OpenAI GPT provider
- `src/worker/providers/google.ts` — Google Gemini provider
- `src/worker/providers/custom.ts` — Generic OpenAI-compatible provider
- `src/worker/providers/factory.ts` — Provider factory function
- `src/council/participation.ts` — Dynamic participation + mid-session recruitment

### Modified files:

- `src/types.ts` — AgentConfig gains `botTokenEnv`, `topics`; CouncilConfig gains `participation`; CouncilMessage gains `threadId`
- `src/config.ts` — Parse new fields with defaults
- `src/index.ts` — Multi-bot init, provider factory, participation config
- `src/gateway/router.ts` — Session-per-thread map, dynamic participant selection, multi-bot sending, recruitment messages
- `src/telegram/bot.ts` — Listener/sender bot separation, multi-bot management
- `src/telegram/handlers.ts` — Pass threadId through
- `src/council/role-assigner.ts` — Accept filtered participant list instead of all agents
- `config/council.yaml` — Add participation section
- `config/agents/huahua.yaml` — Add bot_token_env, topics
- `config/agents/binbin.yaml` — Add bot_token_env, topics
- `.env.example` — Per-agent tokens, multi-provider keys
- `package.json` — Add openai, @google/genai dependencies

---

## 8. Backward Compatibility

- Existing single-bot setup still works: if agents don't have `bot_token_env`, fall back to `TELEGRAM_BOT_TOKEN` (the Phase 1 env var)
- If `participation` section is missing from config, default to all agents participate in every turn
- If `topics` field is missing from agent config, default to `[general]`
- Claude-only setups work without OpenAI/Google keys

---

## 9. Design Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|-------------|-----------|
| Bot architecture | One bot per agent | Single bot with prefixes; webhook relay | Cleanest identity separation; each agent has own avatar/name |
| Polling strategy | Single listener bot | All bots poll; webhook mode | Avoids 409 conflicts; simple |
| Provider additions | OpenAI + Google + Custom | Only OpenAI; only Google | Maximum flexibility; Custom covers Ollama/Together/Groq |
| Topic threads | Follow human, don't auto-create | Auto-create; ignore threads | Least invasive; human controls structure |
| Session isolation | Per thread_id | Global session; per-agent sessions | Natural mapping to Telegram threads |
| Participation | Dynamic per-turn, max 3 | Fixed; all agents always | Cost control + relevance; mid-session recruitment adds flexibility |
| Recruitment | Automatic with notification | Silent; manual only | Transparent to human; human can override |
| Agent cap | 3 per turn | 2; 5; unlimited | Balance of diversity and cost |
