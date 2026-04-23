# Agent Council

1 human + N AI agents collaborating naturally in a Telegram group chat.

An open-source framework where multiple AI agents discuss, debate, and challenge each other in a Telegram group -- with you as the final decision maker. Each agent gets its own Telegram bot (independent name and avatar), and built-in anti-sycophancy mechanisms prevent agents from just agreeing with each other.

## Features

- **Multi-agent group chat** -- send a message, multiple AI agents respond and challenge each other in real time
- **4 LLM providers** -- Claude, OpenAI (GPT), Google (Gemini), and any OpenAI-compatible API (Ollama, Groq, Together, etc.)
- **One bot per agent** -- each agent appears as a separate Telegram bot with its own name and avatar
- **Anti-sycophancy engine** -- 5 defense layers prevent agents from converging into groupthink
- **Anti-pattern detection** -- LLM-powered detection of mirror responses, fake dissent, quick surrender, and authority submission
- **Cognitive memory system** -- SQLite + markdown with gist extraction, adaptive forgetting, usage tracking, episodic-to-semantic consolidation, and confidence tagging
- **Dynamic participation** -- agents join and leave discussions based on topic relevance
- **Role assignment** -- agents are assigned roles (advocate, critic, analyst, reviewer) based on the topic
- **Per-thread session isolation** -- each Telegram supergroup forum thread runs an independent session
- **Session lifecycle** -- auto-summarize on keywords, inactivity timeout, or turn limit
- **Context health** -- sliding window compression prevents quality degradation in long conversations

## Quick Start

1. **Clone and install:**
   ```bash
   git clone https://github.com/Imbad0202/agent-council.git
   cd agent-council
   npm install
   ```

2. **Create your `.env`:**
   ```bash
   cp .env.example .env
   ```

3. **Configure environment variables** -- add your API keys and Telegram tokens (see [Environment Variables](#environment-variables) below).

4. **Configure your agents** in `config/agents/` (see [Agent Config](#agent-config)).

5. **Start:**
   ```bash
   npm run dev
   ```

Send a message in your Telegram group and the agents will respond.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN_<AGENT>` | Yes (one per agent) | Per-agent bot token from @BotFather |
| `TELEGRAM_BOT_TOKEN` | Fallback | Single token used for all agents if per-agent tokens are not set |
| `TELEGRAM_GROUP_CHAT_ID` | Yes | Your Telegram group's chat ID (negative number for groups) |
| `ANTHROPIC_API_KEY` | If using Claude | Anthropic API key |
| `OPENAI_API_KEY` | If using GPT | OpenAI API key |
| `GOOGLE_AI_API_KEY` | If using Gemini | Google AI API key |
| `CUSTOM_PROVIDER_URL` | If using custom | OpenAI-compatible API base URL (e.g. `http://localhost:11434/v1`) |
| `CUSTOM_PROVIDER_API_KEY` | If custom requires auth | API key for the custom provider |
| `MEMORY_SYNC_PATH` | No | Path to external memory repo for agent personality/knowledge |

### Agent Config

Each agent is a YAML file in `config/agents/`. Create one file per agent.

```yaml
# config/agents/myagent.yaml
id: myagent                              # Unique identifier
name: MyAgent                            # Display name
provider: claude                         # LLM provider: claude | openai | google | custom
model: claude-opus-4-7                   # Model name for the provider
bot_token_env: TELEGRAM_BOT_TOKEN_MYAGENT  # Env var name holding this agent's bot token
topics: [code, risk, testing, general]   # Topics this agent is interested in
memory_dir: MyAgent/global               # Directory for external memory (optional)
personality: |                           # System prompt personality
  You are MyAgent. You have your own opinions and judgment.
  You won't abandon your position just for the sake of harmony.
```

Available topic keywords: `code`, `strategy`, `research`, `architecture`, `risk`, `testing`, `general`.

### Council Config

`config/council.yaml` controls the overall behavior of the council:

```yaml
# Gateway: message routing and turn management
gateway:
  thinking_window_ms: 5000          # Delay before agents start responding
  random_delay_ms: [1000, 3000]     # Random delay range between agent responses
  max_inter_agent_rounds: 3         # Max rounds of agent-to-agent exchange per human turn
  context_window_turns: 10          # How many turns to keep in the sliding context window
  session_max_turns: 20             # Auto-summarize after this many turns

# Anti-sycophancy: prevent agents from just agreeing with each other
anti_sycophancy:
  disagreement_threshold: 0.2       # Below this rate, inject a challenge
  consecutive_low_rounds: 3         # How many low-disagreement rounds before intervening
  challenge_angles:                 # Angles for challenge injection
    - cost
    - risk
    - alternatives
    - long-term impact
    - scalability
    - maintainability

# Role assignment
roles:
  default_2_agents:                 # Default roles when 2 agents participate
    - advocate
    - critic
  topic_overrides:                  # Override roles based on detected topic
    code: [author, reviewer]
    strategy: [advocate, critic]

# Memory system
memory:
  db_path: data/brain.db            # SQLite database path
  session_timeout_ms: 600000        # 10 minutes of inactivity triggers summary
  end_keywords: ["done", "wrap up"] # Keywords that trigger session summary
  archive_threshold: 30             # Archive when memory count exceeds this
  archive_bottom_percent: 20        # Archive the bottom 20% by retrieval score
  consolidation_threshold: 5        # Consolidate after 5 sessions on the same topic

# Anti-pattern detection (LLM-powered)
anti_pattern:
  enabled: true
  detection_model: claude-sonnet-4-6  # Lightweight model for detection
  start_after_turn: 3               # Start detecting after turn 3
  detect_every_n_turns: 2           # Run detection every 2 turns

# Dynamic participation
participation:
  max_agents_per_turn: 3            # At most 3 agents respond per turn
  min_agents_per_turn: 2            # At least 2 agents respond per turn
  recruitment_message: true         # Announce when agents join/leave
  listener_agent: huahua            # Which agent's bot listens for human messages
```

## Multi-Model Setup

Each agent can use a different LLM provider. Mix and match models by setting the `provider` field in each agent config:

```yaml
# config/agents/claude-agent.yaml
provider: claude
model: claude-opus-4-7

# config/agents/gpt-agent.yaml
provider: openai
model: gpt-5

# config/agents/gemini-agent.yaml
provider: google
model: gemini-2.5-pro

# config/agents/local-agent.yaml
provider: custom                         # Any OpenAI-compatible API
model: llama3.3:70b                      # Model name the API expects
```

Set the corresponding API key environment variables for each provider you use. Agents sharing the same provider reuse a single client instance.

## Architecture

```
Telegram Group Chat
    |
    v
BotManager (1 bot per agent, listener bot receives human messages)
    |
    v
GatewayRouter (per-thread session isolation)
    ├── TurnManager (turn-taking, delay, queuing)
    ├── AntiSycophancyEngine (challenge injection, convergence detection)
    ├── PatternDetector (LLM-powered anti-pattern detection)
    ├── ParticipationManager (topic-based agent selection)
    └── RoleAssigner (topic-aware role assignment)
         |
         v
    AgentWorker (1 per agent)
    ├── LLM Provider (Claude / OpenAI / Google / Custom)
    ├── Personality Builder (system prompt + memory + role)
    └── Stats Tracking (response count, disagreement rate, skip count)
         |
         v
    Memory Layer (SQLite + Markdown)
    ├── SessionLifecycle (auto-summarize on keyword/timeout/turn limit)
    ├── UsageTracker (reference counting across sessions)
    ├── MemoryConsolidator (episodic → semantic consolidation)
    └── MemoryPruner (adaptive forgetting by retrieval score)
```

## Memory System

The memory system is inspired by cognitive science, with 5 layers:

1. **Gist Extraction** -- When a session ends, the LLM extracts the topic, outcome (decision/open/deferred), and a confidence score. Each agent gets a markdown summary saved to disk and indexed in SQLite.

2. **Usage Tracking** -- Every time an agent references a past memory in its response, the reference count increments and the last-used timestamp updates. Frequently referenced memories rise in retrieval priority.

3. **Adaptive Forgetting** -- When an agent's active memory count exceeds the threshold, the bottom N% by retrieval score (a function of usage count and recency) are archived. Archived memories are moved to an `archive/` directory and excluded from active retrieval.

4. **Episodic-to-Semantic Consolidation** -- When an agent accumulates enough session memories on the same topic, the consolidator asks the LLM to extract a general principle and a behavioral pattern. The sessions are archived, replaced by a single higher-confidence principle record.

5. **Confidence Tagging** -- Every memory record carries a confidence score (0.0--1.0). Session memories start around 0.5--0.7; consolidated principles are elevated to 0.9. Full-text search (FTS5) and topic-based retrieval prioritize high-confidence records.

## Anti-Sycophancy

The system uses 5 defense layers to prevent agents from converging into groupthink:

1. **Challenge Injection** -- Before each response, agents receive the previous agent's position and must list at least 2 potential problems, risks, or blind spots before giving their own perspective.

2. **Response Classification** -- Every response is classified as `opposition`, `conditional`, or `agreement` based on linguistic signals (in both English and Chinese).

3. **Convergence Detection** -- If the disagreement rate drops below the threshold for consecutive rounds, the system injects a challenge from a random angle (cost, risk, alternatives, scalability, etc.).

4. **Anti-Pattern Detection** -- An LLM-powered detector runs every N turns and checks for 4 patterns:
   - **Mirror** -- Agent B's response is semantically identical to Agent A's, just rephrased
   - **Fake Dissent** -- Agent opens with "I disagree" but reaches the same conclusion
   - **Quick Surrender** -- Agent had a position but immediately abandoned it after one challenge
   - **Authority Submission** -- Agent changed stance because the human sided with the other agent

5. **Pattern-Specific Injection** -- When a pattern is detected, the targeted agent receives a specific prompt challenging the detected behavior (e.g., "You claimed to disagree but reached the same conclusion. Under what circumstances would you actually reach a different conclusion?").

## Dynamic Participation

Not every agent needs to respond to every message. The participation system:

1. **Topic Detection** -- Incoming messages are scanned for topic keywords (code, strategy, research, architecture, risk, testing).

2. **Agent Scoring** -- Each agent is scored by how many of its declared topics match the detected topics. `general` topic gives a base score; specific topic matches score higher.

3. **Selection** -- The top-scoring agents (up to `max_agents_per_turn`) are selected. If fewer agents qualify than `min_agents_per_turn`, additional agents are pulled in.

4. **Recruitment** -- When the topic shifts mid-conversation, relevant agents join and irrelevant agents (who have been silently skipping) leave. Join/leave announcements are posted to the chat.

## Testing

```bash
npm test              # Run all 104 tests
npm run test:watch    # Watch mode
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode (watch + auto-reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled output |
| `npm test` | Run the test suite (vitest) |

## Docker

```bash
# Build and run
docker compose up -d

# Or build manually
docker build -t agent-council .
docker run -d --env-file .env -v ./data:/app/data -v ./config:/app/config agent-council
```

Mount `data/` to persist brain.db and session summaries. Mount `config/` to customize agents and council settings.

## Stress test mode

The `sneaky-prover` role generates a plausible-but-wrong response on purpose, so the council and user can practice spotting subtle errors. Trigger via Telegram:

```
/stresstest your question here
```

One randomly-selected agent will play sneaky-prover for that round. After the round, the bot posts a `🔒 [SNEAKY DEBRIEF]` message revealing the planted error.

Inspired by Kirchner et al. 2024, [*Prover-Verifier Games improve legibility of LLM outputs*](https://arxiv.org/abs/2407.13692).

## Blind review mode

Evaluate agents behind a Rawlsian veil. Trigger:

```
/blindreview <your topic>
```

Agents respond as `Agent-A`, `Agent-B`, ... (codes assigned by sorted agent id, deterministic). After the round, the bot posts a scoring panel (1-5★ per agent). When you've scored every agent, identities are revealed alongside your scores:

```
🎭 Blind Review Reveal

Agent-A → Claude (role: critic) — your score: 4★
Agent-B → GPT (role: advocate) — your score: 5★
```

To abandon a pending session, use `/cancelreview`.

Note: anonymous broadcast routes all agent messages through a single sender bot, so per-agent bot identities (avatars, names) are uniform during a blind round — that's the point.

## Long-running sessions

Past ~100 turns, agent responses drift. Prompt caching keeps token cost down but does not fix coherence. `/councilreset` produces a structured summary of the current segment (decisions, open questions, evidence pointers, blind-review state), persists it, and starts a new segment — subsequent turns resume with the summary as shared context instead of the full prior transcript.

```
/councilreset
```

Works on CLI and Telegram. The reply names the sealed segment index and the decision + open-question counts.

`/councilhistory` lists every reset point for the current thread:

```
[0] 2026-04-23T09:00:00Z — 3 decisions, 1 open
```

The snapshot is surfaced to every agent on the next turn as the first user-role message, so Claude, OpenAI, and Gemini peers see it uniformly.

See [docs/LONG_RUNNING_COUNCIL.md](docs/LONG_RUNNING_COUNCIL.md) for guards, recovery semantics, and the cache trade-off (Claude-only `systemPromptParts` cache for the snapshot is deferred to v0.5.2).

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
