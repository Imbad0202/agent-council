# agent-council

1 human + N AI agents collaborating naturally in a Telegram group chat.

## What is this?

An open-source framework where multiple AI agents discuss, debate, and challenge each other in a Telegram group — with you as the final decision maker. Built-in anti-sycophancy mechanisms prevent agents from just agreeing with each other.

## Features

- **Natural group chat** — send a message, agents respond and challenge each other
- **Dynamic role assignment** — agents are assigned roles (advocate, critic, analyst) based on the topic
- **Anti-sycophancy engine** — challenge injection, disagreement monitoring, convergence detection
- **Context health** — sliding window compression prevents quality degradation in long conversations
- **Memory integration** — reads from [claude-memory-sync](https://github.com/Imbad0202/claude-memory-sync) for agent personality and knowledge
- **Session summaries** — automatic gist extraction when discussions end
- **Model-agnostic interface** — Claude MVP, designed for multi-model support (GPT, Gemini)

## Quick Start

1. Clone and install:
   ```bash
   git clone https://github.com/Imbad0202/agent-council.git
   cd agent-council
   npm install
   ```

2. Configure `.env`:
   ```bash
   cp .env.example .env
   # Edit .env with your API keys and group chat ID
   ```

3. Configure agents in `config/agents/*.yaml`

4. Start:
   ```bash
   npm run dev
   ```

5. Send a message in your Telegram group — agents will respond.

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_GROUP_CHAT_ID` | Your Telegram group's chat ID |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `MEMORY_SYNC_PATH` | Absolute path to claude-memory-sync repo |

### Agent Config (`config/agents/*.yaml`)

```yaml
id: myagent
name: MyAgent
provider: claude
model: claude-opus-4-6
memory_dir: MyAgent/global
personality: |
  You are MyAgent. You have your own opinions.
```

### Council Config (`config/council.yaml`)

Controls turn-taking, anti-sycophancy thresholds, and role assignments.

## Architecture

See `docs/superpowers/specs/2026-04-12-agent-council-design.md` for the full design spec.

```
Gateway (message routing, turn management, context health)
    ├── Agent Worker 1 (independent LLM instance + memory)
    ├── Agent Worker 2 (independent LLM instance + memory)
    └── Council Engine (role assignment, anti-sycophancy)
```

## License

MIT
