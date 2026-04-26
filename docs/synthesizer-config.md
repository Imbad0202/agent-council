# `artifact-synthesizer` Worker Config

`/councildone` requires a worker config with `role_type: artifact-synthesizer` to produce artifacts. Without one, `/councildone` rejects with a friendly "not configured" message.

## Adding a synthesizer

Create a YAML file under `config/agents/` (any name; convention: `synthesizer.yaml`):

```yaml
id: synth
name: Artifact Synthesizer
provider: claude         # or openai / google / custom
model: claude-sonnet-4-6
memory_dir: data/synthesizer-memory
personality: "Artifact synthesizer placeholder."   # placeholder ONLY — IGNORED by /councildone (uses provider.chat directly, bypassing personality.ts). The loader (src/config.ts) currently rejects empty strings, so this field must be non-empty even though it has no effect on synthesis.
role_type: artifact-synthesizer
```

Restart the bot. On startup the synthesizer config is detected and `ArtifactService` becomes available.

## Notes

- The synthesizer worker is **excluded** from the peer pool — it never participates in normal `/council` deliberations.
- The synthesizer's provider is **lazy-instantiated** — only constructed when `/councildone` actually runs, so adding a config that references a not-yet-set env var doesn't break startup.
- `personality.ts`'s markdown ban is bypassed for `/councildone` (synthesizer needs to emit markdown headings).
