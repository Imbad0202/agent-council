# Contributing to Agent Council

Contributions are welcome! This guide covers the basics to get you started.

## Development Setup

```bash
git clone https://github.com/imbad0202/agent-council.git
cd agent-council
npm install
npm run dev
```

Run tests:

```bash
npm test
```

Type check:

```bash
npx tsc --noEmit
```

## Adding a New LLM Provider

1. Create `src/worker/providers/yourprovider.ts` extending `BaseProvider`
2. Implement the `chat()` method
3. Register in `src/worker/providers/factory.ts`
4. Add the required env var to `.env.example`
5. Add tests in `tests/worker/providers/yourprovider.test.ts`

## Adding a New Agent

1. Create a YAML file in `config/agents/`
2. Create a Telegram bot via [@BotFather](https://t.me/BotFather)
3. Add the bot token to `.env`

## Code Style

- TypeScript strict mode
- Tests required for new features
- Follow existing patterns

## Pull Requests

- One feature per PR
- Tests must pass (CI runs automatically)
- Keep PRs focused and small
