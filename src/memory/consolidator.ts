import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { MemoryDB } from './db.js';
import type { LLMProvider, MemoryRecord } from '../types.js';

export class MemoryConsolidator {
  private db: MemoryDB;
  private dataDir: string;
  private llm: LLMProvider;
  private model: string;

  constructor(db: MemoryDB, dataDir: string, llm: LLMProvider, model: string) {
    this.db = db;
    this.dataDir = dataDir;
    this.llm = llm;
    this.model = model;
  }

  /**
   * Find topics with >= threshold session-type memories for a given agent.
   */
  getConsolidatableTopics(agentId: string, threshold: number): string[] {
    const sessions = this.db.listMemories(agentId, 'session');

    // Count sessions per topic
    const topicCounts = new Map<string, number>();
    for (const s of sessions) {
      if (s.topic) {
        topicCounts.set(s.topic, (topicCounts.get(s.topic) ?? 0) + 1);
      }
    }

    const topics: string[] = [];
    for (const [topic, count] of topicCounts) {
      if (count >= threshold) {
        topics.push(topic);
      }
    }

    return topics;
  }

  /**
   * Consolidate all session memories for an agent+topic into a single principle.
   *
   * 1. Read markdown files for each session memory
   * 2. Ask LLM to extract principle + behavioral pattern
   * 3. Save principle as a markdown file with frontmatter
   * 4. Insert principle record into DB
   * 5. Insert pattern into DB patterns table
   * 6. Archive all original session records (update type, move files)
   */
  async consolidate(agentId: string, topic: string): Promise<void> {
    // 1. Get all session memories for this agent+topic
    const sessions = this.db.getMemoriesByTopic(agentId, topic, 'session');
    if (sessions.length === 0) return;

    // 2. Read their markdown files
    const contents: string[] = [];
    for (const session of sessions) {
      const filePath = join(this.dataDir, session.id);
      if (existsSync(filePath)) {
        contents.push(readFileSync(filePath, 'utf-8'));
      }
    }

    if (contents.length === 0) return;

    // 3. Ask LLM to extract a principle + behavioral pattern
    const userPrompt = contents.map((c, i) => `--- Session ${i + 1} ---\n${c}`).join('\n\n');

    const response = await this.llm.chat(
      [{ role: 'user', content: userPrompt }],
      {
        model: this.model,
        systemPrompt: [
          'Analyze these discussion summaries and extract:',
          '1. A general principle (2-3 sentences) that captures the recurring conclusions and decisions.',
          '2. A behavioral pattern for the agent (one sentence): "tends toward [behavior] on [topic]"',
          '3. Decision rules (array of strings): concrete rules in format "When encountering X, prioritize Y"',
          '',
          'Respond in JSON format:',
          '{"principle": "...", "pattern": "...", "decision_rules": ["...", "..."]}',
          '',
          'Respond in the same language as the input.',
        ].join('\n'),
      },
    );

    const parsed = JSON.parse(response.content) as { principle: string; pattern: string; decision_rules?: string[] };

    // 4. Save principle as markdown with frontmatter
    const principleDir = join(this.dataDir, agentId, 'principles');
    mkdirSync(principleDir, { recursive: true });

    const principleFilename = `principle-${topic}.md`;
    const principlePath = join(principleDir, principleFilename);
    const principleId = `${agentId}/principles/${principleFilename}`;
    const now = new Date().toISOString().slice(0, 10);

    const frontmatter = [
      '---',
      `topic: ${topic}`,
      `type: principle`,
      `consolidatedFrom: ${sessions.length} sessions`,
      `createdAt: ${now}`,
      '---',
      '',
      parsed.principle,
    ].join('\n');

    writeFileSync(principlePath, frontmatter);

    // 5. Insert principle record into brain.db
    const principleRecord: MemoryRecord = {
      id: principleId,
      agentId,
      type: 'principle',
      topic,
      confidence: 0.9,
      outcome: 'decision',
      usageCount: 0,
      lastUsed: now,
      createdAt: now,
      contentPreview: parsed.principle,
    };
    this.db.insertMemory(principleRecord);

    // 5b. Insert decision rules if extracted
    const rules = parsed.decision_rules;
    if (rules && rules.length > 0) {
      for (let i = 0; i < rules.length; i++) {
        const ruleId = `${agentId}/rules/rule-${topic}-${i + 1}.md`;
        this.db.insertMemory({
          id: ruleId, agentId, type: 'rule', topic, confidence: 0.85,
          outcome: 'decision', usageCount: 0, lastUsed: now, createdAt: now,
          contentPreview: rules[i],
        });
      }
    }

    // 6. Insert pattern into brain.db patterns table
    this.db.insertPattern({
      agentId,
      topic,
      behavior: parsed.pattern,
      extractedFrom: principleId,
    });

    // 7. Archive all original sessions (update type in DB, move files to archive/)
    const archiveDir = join(this.dataDir, agentId, 'archive');
    mkdirSync(archiveDir, { recursive: true });

    for (const session of sessions) {
      this.db.updateType(session.id, 'archive');

      const sourcePath = join(this.dataDir, session.id);
      const destPath = join(archiveDir, basename(session.id));

      if (existsSync(sourcePath)) {
        renameSync(sourcePath, destPath);
      }
    }
  }
}
