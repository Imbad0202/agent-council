import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CouncilMessage, LLMProvider } from '../types.js';

export async function generateSessionSummary(
  messages: CouncilMessage[],
  agentIds: string[],
  provider: LLMProvider,
  model: string,
): Promise<string> {
  const transcript = messages
    .map((m) => {
      const speaker = m.role === 'human' ? 'Human' : m.agentId ?? 'Agent';
      return `${speaker}: ${m.content}`;
    })
    .join('\n\n');

  return provider.summarize(transcript, model);
}

export function saveSessionSummary(
  dataDir: string,
  agentIds: string[],
  summaryContent: string,
  topic: string,
): void {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `council-session-${date}-${topic}.md`;

  const frontmatter = `---
name: "Council: ${topic}"
type: council-session
confidence: 0.7
participants: [${agentIds.join(', ')}]
outcome: open
usage_count: 0
last_used: ${date}
---`;

  const fullContent = `${frontmatter}\n\n${summaryContent}\n`;

  for (const agentId of agentIds) {
    const sessionDir = join(dataDir, agentId, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, filename), fullContent, 'utf-8');
  }
}
