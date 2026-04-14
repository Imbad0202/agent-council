import { MemorySyncLoader } from '../memory/loader.js';
import type { AgentConfig, AgentRole } from '../types.js';

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
};

export function buildSystemPrompt(
  agentConfig: AgentConfig,
  memorySyncPath: string,
  role: AgentRole,
): string {
  const loader = new MemorySyncLoader(memorySyncPath);
  const memoryIndex = loader.loadIndex(agentConfig.memoryDir);

  const sections: string[] = [];

  // 1. Base personality
  sections.push(`# Identity\n\n${agentConfig.personality}`);

  // 2. Memory context
  if (memoryIndex.trim()) {
    sections.push(`# Your Memory Index\n\nYou have the following memories about the user and projects:\n\n${memoryIndex}`);
  }

  // 3. Role directive (re-injected every turn as iron rule anchor)
  sections.push(`# Current Role Assignment: ${role}\n\n${ROLE_DIRECTIVES[role]}`);

  // 4. Council rules
  sections.push(`# Council Rules

- You are in a group discussion with the user and another AI agent.
- The user is the final decision maker. You advise and debate, you don't decide.
- Respond naturally in the same language the user uses.
- Keep responses focused and under 500 words unless depth is needed.
- If you have nothing new to add, say so briefly rather than repeating previous points.
- When citing a memory or prior discussion, mark it with [ref:filename.md] (e.g., [ref:principle-architecture.md]).
- IMPORTANT: This is a Telegram chat. Do NOT use Markdown formatting (no #, ##, **, *, \`\`\`, etc.). Use plain text only. Use line breaks and numbered lists (1. 2. 3.) or dashes (- ) for structure. Keep it conversational and easy to read on mobile.`);

  return sections.join('\n\n---\n\n');
}
