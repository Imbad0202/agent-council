import { CliAdapter, type CliAdapterConfig } from './cli.js';
import { TelegramAdapter, type TelegramAdapterConfig } from './telegram.js';
import type { Adapter } from './types.js';

export interface AdapterFactoryConfig {
  cli: CliAdapterConfig;
  telegram: TelegramAdapterConfig;
}

export interface ParsedArgs {
  adapter: string;
  verbose: boolean;
  message?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let adapter = 'telegram';
  let verbose = false;
  let message: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--adapter=')) {
      adapter = arg.slice('--adapter='.length);
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (!arg.startsWith('--')) {
      message = arg;
    }
  }

  return { adapter, verbose, message };
}

export function createAdapter(name: string, config: AdapterFactoryConfig): Adapter {
  switch (name) {
    case 'cli':
      return new CliAdapter(config.cli);
    case 'telegram':
      return new TelegramAdapter(config.telegram);
    default:
      throw new Error(`Unknown adapter: ${name}. Available: telegram, cli`);
  }
}
