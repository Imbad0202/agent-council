import * as readline from 'node:readline';
import chalk from 'chalk';
import type { InputAdapter, OutputAdapter, AdapterMessage, RichMetadata } from './types.js';
import {
  dispatchCritiqueRequest,
  type HumanCritiqueWiring,
  type CritiqueRequest,
  type CritiquePromptResult,
} from '../council/human-critique-wiring.js';
import type { HumanCritiqueStance } from '../council/human-critique.js';

export interface CliAdapterConfig {
  verbose: boolean;
}

// Narrow structural interface for feature-detecting the readline-based prompt
// path in src/index.ts. Renaming the method on the class breaks this.
export interface DefaultCritiquePromptAdapter {
  defaultPromptUser(req: CritiqueRequest): Promise<CritiquePromptResult>;
}

const AGENT_COLORS: Record<string, (text: string) => string> = {
  huahua: chalk.cyan,
  binbin: chalk.yellow,
  facilitator: chalk.magenta,
};
const AGENT_COLOR_KEYS = Object.keys(AGENT_COLORS);

export class CliAdapter implements InputAdapter, OutputAdapter {
  verbose: boolean;
  private rl: readline.Interface | null = null;
  private onMessageCallback: ((msg: AdapterMessage) => void) | null = null;
  private critiqueWiring: HumanCritiqueWiring | undefined;

  constructor(config: CliAdapterConfig) {
    this.verbose = config.verbose;
  }

  setHumanCritiqueWiring(wiring: unknown): void {
    this.critiqueWiring = wiring as HumanCritiqueWiring;
  }

  async handleCritiqueRequest(req: CritiqueRequest): Promise<void> {
    await dispatchCritiqueRequest(this.critiqueWiring, req);
  }

  // Default prompt implementation — a two-stage readline prompt that first
  // asks (y/n) whether to critique, then collects stance + content if yes.
  // Wired in by the bootstrap layer via setHumanCritiqueWiring's promptUser.
  async defaultPromptUser(req: CritiqueRequest): Promise<CritiquePromptResult> {
    if (!this.rl) return { kind: 'skipped' };
    const banner = chalk.magenta(
      `\n[critique window] ${req.prevAgent} → ${req.nextAgent}. Interject? (c=challenge / q=question / p=addPremise / Enter=skip)`,
    );
    const stance = await this.ask(`${banner}\n> `);
    const stanceMap: Record<string, HumanCritiqueStance | undefined> = {
      c: 'challenge',
      q: 'question',
      p: 'addPremise',
    };
    const chosen = stanceMap[stance.trim().toLowerCase()];
    if (!chosen) return { kind: 'skipped' };
    const content = await this.ask(chalk.magenta('critique text > '));
    const trimmed = content.trim();
    if (!trimmed) return { kind: 'skipped' };
    return { kind: 'submitted', stance: chosen, content: trimmed };
  }

  private ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.rl) { resolve(''); return; }
      this.rl.question(prompt, (answer) => resolve(answer));
    });
  }

  async start(onMessage: (msg: AdapterMessage) => void): Promise<void> {
    this.onMessageCallback = onMessage;
    console.log(chalk.bold('\n═══════════════════════════════════════════'));
    console.log(chalk.bold('  Agent Council CLI v0.2.1'));
    console.log(chalk.dim('  Type /help for commands, /quit to exit'));
    console.log(chalk.bold('═══════════════════════════════════════════\n'));
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: chalk.green('You > ') });
    this.rl.prompt();
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) { this.rl?.prompt(); return; }
      if (this.onMessageCallback) this.onMessageCallback({ content: trimmed, threadId: 0 });
      this.rl?.prompt();
    });
    this.rl.on('close', () => { console.log(chalk.dim('\nGoodbye.')); });
  }

  async stop(): Promise<void> { this.rl?.close(); this.rl = null; }

  async send(agentId: string, content: string, metadata: RichMetadata, threadId?: number): Promise<void> {
    process.stdout.write(this.formatAgentMessage(content, metadata) + '\n');
    this.rl?.prompt();
  }

  async sendSystem(content: string, threadId?: number): Promise<void> {
    process.stdout.write(chalk.gray(content) + '\n');
    this.rl?.prompt();
  }

  formatAgentMessage(content: string, metadata: RichMetadata): string {
    const colorFn = AGENT_COLORS[metadata.agentName]
      ?? AGENT_COLORS[AGENT_COLOR_KEYS.find(k => metadata.agentName.includes(k)) ?? '']
      ?? chalk.white;
    const roleTag = metadata.role ? ` [${metadata.role}]` : '';
    const header = colorFn(`${metadata.agentName}${roleTag} >`);
    const body = ` ${content}`;
    if (this.verbose && (metadata.emotion || metadata.stanceShift)) {
      const metaLine = chalk.dim(`  [Emotion: ${metadata.emotion ?? 'neutral'} | Stance: ${metadata.stanceShift ?? 'unchanged'}]`);
      return `${header}${body}\n${metaLine}`;
    }
    return `${header}${body}`;
  }

  isCommand(input: string): boolean { return input.startsWith('/'); }

  parseCommand(input: string): { command: string; args: string } {
    const spaceIdx = input.indexOf(' ');
    if (spaceIdx === -1) return { command: input.slice(1), args: '' };
    return { command: input.slice(1, spaceIdx), args: input.slice(spaceIdx + 1).trim() };
  }

  toggleVerbose(): void { this.verbose = !this.verbose; }
}
