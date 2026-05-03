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

## Model Version Policy

When choosing a model ID for an agent, council system task, or default:

- **Use the latest GA model in the provider family.** When the provider ships a
  new minor version (e.g. `gpt-5.4` → `gpt-5.5`, `claude-sonnet-4-6` →
  `claude-sonnet-4-7`), bump the agent-council references promptly. Each
  scaffold encodes assumptions about what the prior model could not do; staying
  on previous versions silently accumulates drift.
- **Cost is not a pin reason.** If the latest is too expensive for a role,
  switch to a smaller tier of the *same* generation (e.g. `gpt-5.5-mini`,
  `claude-haiku-X`) — never pin to a previous-generation flagship as a cost
  workaround. Pinning to an older flagship for cost reasons gives the worst of
  both: yesterday's quality with no clear cost story.
- **Pinning requires linked evidence.** If you must pin to a non-latest
  version, the inline comment must reference a specific regression incident,
  reproducible test case, or A/B measurement. "I think it might be worse" is
  not a pin reason.
- **Re-audit on each provider release.** When a frontier model ships, run the
  `/harness-retirement` skill (or `audits/harness-retirement-*.md` workflow)
  to surface model-id and `budget_tokens` / `temperature` / few-shot
  scaffolds that may no longer be needed.

Decision precedent: 2026-05-03 — `huahua: gpt-5.4 → gpt-5.5` bumped
without per-role measurement (codex CLI 0.128 dogfood at gpt-5.5 default
treated as ambient signal). See `audits/harness-retirement-2026-05-03.md`
F-002 for the deliberation that produced this policy.

## Code Style

- TypeScript strict mode
- Tests required for new features
- Follow existing patterns

## Pull Requests

- One feature per PR
- Tests must pass (CI runs automatically)
- Keep PRs focused and small
