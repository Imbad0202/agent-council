# 3-Agent Multi-Model Example

A council with 3 agents using different LLM providers:
- **Claude Agent** (Anthropic) — architecture and strategy
- **GPT Agent** (OpenAI) — code and implementation
- **Gemini Agent** (Google) — research and data analysis

## Setup

1. Copy these config files to your `config/agents/` directory
2. Set API keys in `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   OPENAI_API_KEY=sk-...
   GOOGLE_AI_API_KEY=AI...
   ```
3. Create 3 Telegram bots via @BotFather and set tokens in `.env`
4. Run `npm run dev`
