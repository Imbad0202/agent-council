# 2-Agent Local Example

A council with 2 agents both running on a local Ollama instance. Zero API cost.

## Setup

1. Install [Ollama](https://ollama.ai) and pull models:
   ```bash
   ollama pull llama3.3:70b
   ollama pull qwen3:32b
   ```
2. Copy these configs to `config/agents/`
3. Set in `.env`:
   ```
   CUSTOM_PROVIDER_URL=http://localhost:11434/v1
   ```
4. Create 2 Telegram bots and set tokens
5. Run `npm run dev`
