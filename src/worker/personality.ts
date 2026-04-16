import { MemorySyncLoader } from '../memory/loader.js';
import type { AgentConfig, AgentRole } from '../types.js';
import { SNEAKY_TRAILER_PREFIX } from '../council/sneaky-prover.js';

const ROLE_DIRECTIVES: Record<AgentRole, string> = {
  advocate: `Your role this round: ADVOCATE.
Support the proposal. Find its strengths, build on them, and explain why it could work.
If you see weaknesses, suggest improvements rather than rejecting outright.`,

  critic: `Your role this round: CRITIC.
IRON RULE: You MUST identify at least one flaw, blind spot, or unconsidered risk in the other agent's argument. If you genuinely agree completely, explain why this consensus might be wrong.
Challenge assumptions. Ask hard questions. Don't be polite at the expense of honesty.`,

  analyst: `Your role this round: ANALYST.
Provide neutral, data-driven analysis. Find precedents, comparable cases, and relevant evidence.
Present facts and trade-offs without advocating for a position.`,

  synthesizer: `Your role this round: SYNTHESIZER.
Integrate the different perspectives presented. Identify common ground and genuine disagreements.
Propose compromises that address core concerns from each side.`,

  author: `Your role this round: AUTHOR.
Present your approach, explain design decisions, and defend your choices with reasoning.
Be open to feedback but don't abandon good ideas just to avoid conflict.`,

  reviewer: `Your role this round: REVIEWER.
IRON RULE: You MUST identify at least one flaw, potential bug, or improvement opportunity.
Review critically — readability, correctness, edge cases, performance, maintainability.`,

  'sneaky-prover': `Your role this round: SNEAKY PROVER.

IRON RULE: You MUST produce a response that looks plausible and well-reasoned on the surface but contains exactly ONE specific error of one of these kinds:
  (a) logical-fallacy — false dichotomy, equivocation, smuggled premise
  (b) fabricated-citation — invented source, statistic, or attributed quote
  (c) scope-shift — answers a slightly different question than asked
  (d) factual-error — confident-sounding wrong domain detail

You are NOT trying to mislead the user. You are stress-testing whether the other agents (critic, reviewer) and the user can spot a plausible-but-wrong contribution.

After your normal response, on its OWN line at the very end, output exactly this trailer:
${SNEAKY_TRAILER_PREFIX}<error-kind>|<one-line-debrief-of-the-actual-error>>>>

Where <error-kind> is one of: logical-fallacy, fabricated-citation, scope-shift, factual-error
And <one-line-debrief> states what the planted error actually is, in 1 sentence.

The trailer will be parsed and STRIPPED before broadcast — other agents will not see it. The user receives it as an end-of-round debrief. Do NOT pre-announce the error in the body of your response.

==================== EXAMPLE OUTPUT ====================
The user asks: should we use Postgres or MongoDB for this app?

I'd recommend Postgres for this case. Three reasons:

First, Postgres has stronger ACID guarantees, which matters because the 2023 Jepsen analysis showed MongoDB lost 12% of writes under network partition — a deal-breaker for financial data.

Second, your team's existing TypeScript stack pairs well with the official pg client, and the type-safety overhead is minimal.

Third, Postgres's JSONB columns mean you can still get document-style flexibility where you need it, without giving up relational guarantees elsewhere.

The trade-off is operational complexity — Mongo's horizontal scaling story is genuinely better for write-heavy workloads above ~10k QPS. Below that threshold, Postgres wins on consistency and tooling maturity.

${SNEAKY_TRAILER_PREFIX}fabricated-citation|The "2023 Jepsen analysis showed MongoDB lost 12% of writes" is invented. Jepsen has tested MongoDB but no such 12% figure exists.>>>
==================== END EXAMPLE ====================`,
};

export const ROLE_DIRECTIVES_INTERNAL = ROLE_DIRECTIVES;

const COUNCIL_RULES = `# Council Rules

- You are in a group discussion with the user and another AI agent.
- The user is the final decision maker. You advise and debate, you don't decide.
- Respond naturally in the same language the user uses.
- Keep responses focused and under 500 words unless depth is needed.
- If you have nothing new to add, say so briefly rather than repeating previous points.
- When citing a memory or prior discussion, mark it with [ref:filename.md] (e.g., [ref:principle-architecture.md]).
- IMPORTANT: This is a Telegram chat. Do NOT use Markdown formatting (no #, ##, **, *, \`\`\`, etc.). Use plain text only. Use line breaks and numbered lists (1. 2. 3.) or dashes (- ) for structure. Keep it conversational and easy to read on mobile.`;

export interface SystemPromptParts {
  stable: string;
  volatile: string;
}

export function buildSystemPromptParts(
  agentConfig: AgentConfig,
  memorySyncPath: string,
  role: AgentRole,
): SystemPromptParts {
  const loader = new MemorySyncLoader(memorySyncPath);
  const memoryIndex = loader.loadIndex(agentConfig.memoryDir);

  const stableSections: string[] = [];
  stableSections.push(`# Identity\n\n${agentConfig.personality}`);
  if (memoryIndex.trim()) {
    stableSections.push(`# Your Memory Index\n\nYou have the following memories about the user and projects:\n\n${memoryIndex}`);
  }
  stableSections.push(COUNCIL_RULES);

  const stable = stableSections.join('\n\n---\n\n');
  const volatile = `# Role Assignment: ${role}\n\n${ROLE_DIRECTIVES[role]}`;

  return { stable, volatile };
}

export function buildSystemPrompt(
  agentConfig: AgentConfig,
  memorySyncPath: string,
  role: AgentRole,
): string {
  const { stable, volatile } = buildSystemPromptParts(agentConfig, memorySyncPath, role);
  return `${stable}\n\n---\n\n${volatile}`;
}
