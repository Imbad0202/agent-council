# Harness Retirement Audit — `agent-council`

| | |
|-|-|
| Repo path | `~/Projects/agent-council` |
| Branch / commit | `main @ 66bcd4c` (v0.5.4 ship) |
| Date | 2026-05-03 |
| Target model | `claude-opus-4-7` (current) / `claude-sonnet-4-6` (system + critic tier) / `gpt-5.x` (huahua) |
| Files scanned | 23 prompt-bearing files (4 yaml + 19 .ts) |
| Auditor | `/harness-retirement` skill v0.1.0 |

## Executive summary

- **Total findings**: 7 actionable + 9 kept-as-debt annotations
- **By category**:

  | Cat | Count | Priority |
  |-----|------:|----------|
  | 1 — Hardcoded model IDs | 2 | high (mechanical, but hits config not prompts) |
  | 2 — Anti-hallucination patches | 0 | — |
  | 3 — Sampling overrides | 2 | low (no measurement; defer until A/B) |
  | 4 — Few-shot redundancy | 0 actionable (1 in kept-as-debt) | — |
  | 5 — Defensive scaffolding | 0 actionable (5 in kept-as-debt) | — |
  | 6 — Negative framing | 3 | medium (mechanical positive rewrites) |

- **Suggested retirement batch order**: Cat 1 → Cat 6 → Cat 3 (defer)
- **Overall finding**: agent-council prompt surface is healthy. v0.4.0 Opus 4.7 alignment + the post-mortem `feedback_opus_4_7_migration_patterns` discipline left almost no orthodox prompt debt. The 7 findings are all minor cleanups, not regressions waiting to happen. Most "looks like debt" patterns turned out to be either (a) load-bearing anti-sycophancy product features (PVG roles, IRON RULE for critic), (b) parsing-contract-required negative framing (followed by strict validators), or (c) deterministic-mode for structured output (already documented in code comments).

---

## Findings

### [F-001] `src/constants.ts:1` — Category 1 (hardcoded model ID)

**Excerpt**
```ts
export const DEFAULT_SYSTEM_MODEL = 'claude-sonnet-4-6';
```

**Why this is debt.** The constant *looks* like a placeholder (named `DEFAULT_*`) but is itself a hardcoded string literal. When sonnet upgrades to 4.7 or beyond, this needs a manual edit + needs to be remembered across the upgrade checklist. v0.4.0 migration moved a lot of in-code IDs into config/yaml — this one survived because it's the fallback, not a primary pin.

**Proposed change.** Two options to discuss:
1. Read default from env var at startup: `process.env.AGENT_COUNCIL_DEFAULT_SYSTEM_MODEL ?? 'claude-sonnet-4-6'`. Version still appears in code as a last-resort fallback but ops can override without redeploying.
2. Promote to a top-level field in `config/council.yaml` (e.g. `defaults.system_model`); read once via `config.ts`. Removes the literal from `.ts` entirely, all model IDs live in yaml.

Either is fine. Option 2 is cleaner for cross-machine config sync.

**Decision** — [ ] accept option 1  [ ] accept option 2  [ ] reject  [ ] defer

---

### [F-002] `config/agents/huahua.yaml:4` — Category 1 (hardcoded model ID, possibly stale)

**Excerpt**
```yaml
id: huahua
name: 花花
provider: openai
model: gpt-5.4
```

**Why this might be debt.** memory `reference_codex_cli_0121_flag_quirks` (2026-05-02) notes that codex CLI 0.128's default model is now `gpt-5.5`. If `gpt-5.5` is the OpenAI GA flagship as of 2026-05-03, then `gpt-5.4` here is one minor version behind. Audit cannot verify GA status — needs user check.

**Iron-rule check.** Does an A/B between `gpt-5.4` and `gpt-5.5` exist on this huahua workload? If not, mechanical bump is reasonable but should be tested first against blind-review history (we have v0.5+ blind-review scores recorded — a regression on huahua would surface there).

**Proposed change.**
1. Confirm `gpt-5.5` GA via OpenAI release notes / Anthropic codex CLI release notes (this audit cannot reach the network reliably).
2. If GA: bump to `gpt-5.5` and watch the next 5–10 blind-review rounds for huahua regression.
3. If not GA: keep at `gpt-5.4`, annotate with `# pinned to gpt-5.4 — gpt-5.5 not yet GA at YYYY-MM-DD`.

**Decision** — [ ] accept (verify + bump)  [ ] reject (keep gpt-5.4)  [ ] defer (re-audit after OpenAI announces)

---

### [F-003] `src/council/artifact-prompt.ts:25, 51` — Category 6 (negative framing, parsing-contract)

**Excerpt** (line 25, identical at 51)
```
The ## TL;DR section is mandatory. Output ONLY this markdown — no preamble, no commentary.
```

**Why this is debt.** Three negatives ("ONLY", "no preamble", "no commentary") do work that one positive sentence can do, more cleanly. The downstream `parseArtifact` (line 96) regex anchors on `## TL;DR` and `## ` boundaries — it doesn't require the absence of preamble, just that `## TL;DR` is reachable and that no other `## ` heading precedes the body. Positive framing is equivalent and shorter.

**Proposed change.**
```
The ## TL;DR section is mandatory. Begin output with `## TL;DR`. End output with the last list item under `## Suggested next step`.
```
(Symmetric edit at the `DECISION_SYSTEM` line 51, ending with `## Suggested next step` since both presets share that section.)

**Iron-rule check.** Parsing contract preserved (regex still matches). No measurement risk because this is structural framing, not domain knowledge.

**Decision** — [ ] accept  [ ] reject  [ ] defer

---

### [F-004] `src/council/session-reset-prompts.ts:25` — Category 6 (negative framing, parsing-contract)

**Excerpt**
```
Output the markdown only. No preamble, no closing remarks.
```

**Why this is debt.** Same pattern as F-003. The validator (`validateResetSummaryMarkdown`, line 93) checks that all four required H2 sections are present, then `parseSummaryMetadata` counts bullets. Neither cares about preamble. The negative framing is mechanical clutter.

**Proposed change.**
```
Begin output with `## Decisions`. End output with the last bullet under `## Blind-Review State`.
```

**Iron-rule check.** Validator runs BEFORE persist (per the `Round-16 codex finding [P2-VALIDATION]` comment at line 69), so a malformed summary throws `MalformedResetSummaryError`. No regression risk.

**Decision** — [ ] accept  [ ] reject  [ ] defer

---

### [F-005] `src/worker/personality.ts:137` — Category 6 (heavy negative framing for Telegram constraint)

**Excerpt**
```
- IMPORTANT: This is a Telegram chat. Do NOT use Markdown formatting (no #, ##, **, *, ```, etc.). Use plain text only. Use line breaks and numbered lists (1. 2. 3.) or dashes (- ) for structure. Keep it conversational and easy to read on mobile.
```

**Why this is debt.** Six negatives in one line ("Do NOT", "no #", "no ##", "no \*\*", "no \*", "no \`\`\`"). The positive directive ("Use plain text only. Use line breaks and numbered lists or dashes") already says what to do — the prohibition list is reinforcing what the positive instruction implies.

**Proposed change.**
```
- This is a Telegram chat. Use plain text only — line breaks for structure, numbered lists (1. 2. 3.) or dashes (- ) for bullets. Keep it conversational and easy to read on mobile.
```

**Iron-rule check.** The negative enumeration could be load-bearing if Opus 4.7 / Sonnet 4.6 occasionally produce markdown despite plain-text instruction. Anecdotally I have not seen council outputs render with stray markdown in the recent v0.5.x ship logs, but I haven't grep'd `data/council.db` for evidence. **Recommend defer until a quick sample of recent assistant turns confirms zero markdown leaks.**

**Side note (cat-5 scope, not in this finding).** This directive is in the *common* `COUNCIL_RULES` block, applied via `buildSystemPromptParts` regardless of platform. CLI users get the Telegram directive too. ROADMAP §0.6.2 (web UI adapter) will need to address platform-aware rule injection — out of scope for this audit, but flag for v0.6 design.

**Decision** — [ ] accept (rewrite + sample-check)  [ ] reject  [x] defer (sample council.db first)

---

### [F-006] `src/worker/providers/{claude,openai,google,custom}.ts` — Category 3 (default temperature 0.7 across all providers)

**Excerpt** (representative; same pattern in 4 provider files)
```ts
// claude.ts:39
temperature: options.thinking ? 1 : (options.temperature ?? 0.7),

// openai.ts:28
temperature: options.temperature ?? 0.7,

// google.ts:27
temperature: options.temperature ?? 0.7,

// custom.ts:27
temperature: options.temperature ?? 0.7,
```

**Why this might be debt.** All four providers default to `0.7`, which is the legacy generic-chat default. Anthropic's API default is now `1.0` (and Anthropic recommends `1.0` for adversarial / reasoning workloads, which is most of council). For tasks that *want* deterministic output (artifact synth, summaries, classification), the call sites already override (see `artifact-prompt.ts:74` = 0.25, `base.ts:16` summarize = 0.3, `pattern-detector.ts:51` classification = 0.1, etc.). For agent-as-debater respond() paths there is no override — they ride the 0.7 default.

The 0.7 default for debater paths means: a council debate on a high-creativity question runs at 0.7 instead of 1.0. There's no measurement showing 0.7 produces better debate; the value is a 2023-era OpenAI chat completion default.

**Iron-rule check.** Per cat-3 patterns: "lowering = cost control, raising = legacy tuning". 0.7 < 1.0 is a quality choice (more deterministic = potentially less varied debate angles), not cost. No documented A/B. Defer is the right call.

**Proposed change** (for discussion, not for this audit's apply step).
- **Don't change yet**: this is the kind of override that needs an A/B against blind-review scores before flipping. Run two parallel councils on the same topic (one at 0.7, one at 1.0), compare blind-review averages + collaboration-depth scores.
- **If retired**: change all four `?? 0.7` defaults to remove the override (`options.temperature` only, no `??`); let SDK/provider default apply. claude defaults to 1.0, openai/google have their own defaults.

**Decision** — [ ] accept (drop ?? 0.7, ride SDK default)  [ ] reject (0.7 is fine, document why)  [x] defer (run blind-review A/B first)

---

### [F-007] `src/worker/providers/google.ts:26` — Category 3 (Gemini default maxTokens too low)

**Excerpt**
```ts
maxOutputTokens: options.maxTokens ?? 2048,
```

**Why this is debt.** All other providers default to 8192 (claude) or 16384 (openai); google.ts uniquely caps at 2048. This was likely tuned for a Gemini 1.x model where the default output cap was lower. Gemini 2.5 Pro supports 64k+ output. A council debate response at 2048 token cap can be silently truncated on long deliberation turns when caller doesn't pass `maxTokens`.

**Iron-rule check.** No documented A/B / cost reasoning. The example `gemini.yaml.example` is not active by default, so production impact is zero today — but if a user copies it to `gemini.yaml`, the cap activates silently.

**Proposed change.**
```ts
maxOutputTokens: options.maxTokens ?? 8192,  // align with claude default
```
(or remove the `?? 2048` entirely and let the SDK default apply — google `@google/genai` handles unset maxOutputTokens with the model's natural cap.)

**Decision** — [ ] accept (raise to 8192)  [ ] accept (remove default, let SDK decide)  [ ] reject  [ ] defer

---

## Kept as debt (iron rule filtered out)

These were category candidates but filtered out during the audit. Listed so the next audit doesn't surface them again, with reason.

- **`config/council.yaml:38`** `detection_model: claude-sonnet-4-6` — Cat 1. **Kept**: yaml is user-config not prompt text, and `config.ts:94-95` reads it through `system_models?.X ?? DEFAULT_SYSTEM_MODEL`, so the yaml value is an override layered over the constants.ts default. Bumping to a new sonnet version means editing yaml only, not chasing this string. (Same applies to lines 56–57 `intent_classification` / `task_decomposition`.)

- **`config/agents/binbin.yaml:4–11,14–15`** model tier IDs + `thinking.high.mode: adaptive` — Cat 1 + Cat 3. **Kept**: tier IDs are persona-config (not prompt text). `mode: adaptive` is the harness-aware modern API; the comment `# older models can use { mode: enabled, budget_tokens: N }` documents the migration path. This file *is* the retirement-aware reference shape.

- **`config/agents/facilitator.yaml:11–13`** all three tiers `claude-sonnet-4-6` — Cat 1. **Kept**: facilitator deliberately uses sonnet across tiers because it's a routing role, not a debater. Different from binbin/huahua semantics.

- **`config/agents/gemini.yaml.example:6`** `gemini-2.5-pro` — Cat 1. **Kept**: example file documenting a worked config. Hardcoded model in example is docs convention, not deployed code.

- **`src/worker/personality.ts:18,34,39,73,108`** `IRON RULE: You MUST...` (6+ instances across critic / reviewer / sneaky-prover / biased-prover / deceptive-prover / calibrated-prover) — Cat 6. **Kept**: load-bearing anti-sycophancy product feature for `critic` / `reviewer` (the "MUST find at least one flaw" rule is the core of the product per `feedback_aristotelian_middle_path` and the v0.4.0 PVG framework). For PVG roles, the IRON RULE defines the failure-mode contract (sneaky must plant exactly one error, calibrated must declare confidence). Removing it weakens the product.

- **`src/worker/personality.ts:122`** `ROTATION_STEALTH_PREAMBLE` with anti-example list ("avoid first-person framings... 'given my recent experience,' 'I've seen three cases'") — Cat 6 + Cat 4 (anti-example). **Kept**: the anti-example enumeration is more operational than a positive description — these are the specific tells the prover needs to suppress. Per cat-4 iron rule "examples encode edge cases the instruction cannot express".

- **`src/worker/personality.ts:55–69`** sneaky-prover EXAMPLE OUTPUT block — Cat 4. **Kept**: a single canonical example demonstrating (a) normal council voice, (b) trailer placement, (c) what "fabricated-citation" actually looks like in context. Per cat-4 "style calibration" exception. **Open follow-up**: when an evaluation suite exists (post v0.6), do an A/B without the example to measure trailer-format compliance rate. Re-audit.

- **`src/worker/agent-worker.ts:175`** `temperature: 0` in `respondDeterministic` — Cat 3. **Kept**: explicit deterministic-mode for reset-summary generation, with a clear docstring (lines 136–148) explaining why and noting the reproducibility limits. Textbook example of a documented exception to cat-3.

- **silent JSON parse fallback pattern** — present in `intent-gate.ts:75–79` / `pattern-detector.ts:55–62` / `facilitator.ts:202–219` / `lifecycle.ts:64–66` / `dispatcher.ts:55–57`. Cat 5. **Kept**: every fallback returns a fail-safe default that does NOT poison downstream — `intent: 'deliberation'`, `pattern: null`, `decision: {action: 'none'}`, `topic: 'general'`, `tasks: []`. Per cat-5 "the failure is silent — the scaffold repairs invalid JSON into something that parses but is wrong" → this *isn't* what these do; they bail to safe defaults, not malformed payloads. **Re-audit when telemetry exists** (ROADMAP §1.0.2 OTel) to see actual JSON-parse failure rate; if it's > 0.5%, consider promoting to logged warnings (not removing fallback).

---

## Out of scope (noted but not acted)

- **`src/memory/consolidator.ts:90`** `JSON.parse(response.content)` with NO try/catch — opposite of cat-5 (missing defensive scaffolding rather than expired). Robustness gap, but not prompt-debt. Recommend filing as a minor v0.5.x patch (wrap in try/catch, return early with empty consolidation rather than throwing into the consolidate() call chain).

- **Telegram-only directive in shared `COUNCIL_RULES`** (referenced in F-005 side note) — platform-aware system prompt is a v0.6.2 web adapter ROADMAP item; not retirement scope.

---

## Apply log (filled during apply turn)

| Finding | Action | Commit | Verified |
|---------|--------|--------|----------|
| F-001 | pending | — | — |
| F-002 | pending (need GA verify) | — | — |
| F-003 | accepted → applied | (this commit) | 1000/1000 tests pass |
| F-004 | accepted → applied | (this commit) | 1000/1000 tests pass |
| F-005 | deferred (sample council.db first) | — | — |
| F-006 | deferred (blind-review A/B first) | — | — |
| F-007 | pending | — | — |

---

## Next audit

- **Suggested trigger**: next minor release that bumps a default model (e.g. when sonnet → 4.7), or v0.6 ship.
- **Re-scan**: same file set + any new agent files added under `src/council/` / `src/worker/`.
- **Carry forward**: kept-as-debt annotations above. Re-verify load-bearing reasoning is still valid (e.g. when web adapter ships, the F-005 Telegram directive becomes platform-aware; sneaky-prover example becomes A/B-able when evaluation suite lands).
- **Open A/B questions** (record so they don't get lost):
  1. F-006: 0.7 vs 1.0 default temperature on debater paths → blind-review score impact?
  2. Kept sneaky-prover example: trailer compliance rate with vs without?
  3. F-005: incidence rate of stray markdown in v0.5.x Telegram outputs (from `data/council.db`)?
