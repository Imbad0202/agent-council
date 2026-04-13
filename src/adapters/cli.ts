import * as readline from 'node:readline';
import chalk from 'chalk';
import type { InputAdapter, OutputAdapter, AdapterMessage, RichMetadata } from './types.js';

export interface CliAdapterConfig {
  verbose: boolean;
}

const AGENT_COLORS: Record<string, (text: string) => string> = {
  huahua: chalk.cyan,
  binbin: chalk.yellow,
  facilitator: chalk.magenta,
};

export class CliAdapter implements InputAdapter, OutputAdapter {
  verbose: boolean;
  private rl: readline.Interface | null = null;
  private onMessageCallback: ((msg: AdapterMessage) => void) | null = null;

  constructor(config: CliAdapterConfig) {
    this.verbose = config.verbose;
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
    // Try to match by agentId key in AGENT_COLORS, or by checking if agentName contains a key
    const colorFn = AGENT_COLORS[metadata.agentName]
      ?? AGENT_COLORS[Object.keys(AGENT_COLORS).find(k => metadata.agentName.includes(k)) ?? '']
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
