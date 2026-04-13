import { describe, it, expect, vi } from 'vitest';
import { CliAdapter } from '../../src/adapters/cli.js';
import type { RichMetadata } from '../../src/adapters/types.js';
import { parseArgs } from '../../src/adapters/factory.js';

describe('CLI Adapter Integration', () => {
  it('formatAgentMessage handles all agent colors', () => {
    const adapter = new CliAdapter({ verbose: false });
    const huahuaMeta: RichMetadata = { agentName: '花花', role: 'advocate' };
    const binbinMeta: RichMetadata = { agentName: '賓賓', role: 'critic' };
    const facilitatorMeta: RichMetadata = { agentName: '主持人' };

    const h = adapter.formatAgentMessage('test', huahuaMeta);
    const b = adapter.formatAgentMessage('test', binbinMeta);
    const f = adapter.formatAgentMessage('test', facilitatorMeta);

    expect(h).toContain('花花');
    expect(h).toContain('advocate');
    expect(b).toContain('賓賓');
    expect(f).toContain('主持人');
  });

  it('system messages are formatted via sendSystem', async () => {
    const adapter = new CliAdapter({ verbose: false });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await adapter.sendSystem('Session ended: monorepo-debate');
    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Session ended');
    writeSpy.mockRestore();
  });

  it('verbose mode shows metadata, compact hides it', () => {
    const compactAdapter = new CliAdapter({ verbose: false });
    const verboseAdapter = new CliAdapter({ verbose: true });
    const meta: RichMetadata = {
      agentName: '花花', role: 'advocate',
      emotion: 'assertive', stanceShift: 'hardened',
    };
    const compact = compactAdapter.formatAgentMessage('content', meta);
    const verbose = verboseAdapter.formatAgentMessage('content', meta);
    expect(compact).not.toContain('assertive');
    expect(verbose).toContain('assertive');
    expect(verbose).toContain('hardened');
  });

  it('command parsing works for all commands', () => {
    const adapter = new CliAdapter({ verbose: false });
    expect(adapter.isCommand('/sessions')).toBe(true);
    expect(adapter.isCommand('/memory principle-arch')).toBe(true);
    expect(adapter.isCommand('normal message')).toBe(false);
    expect(adapter.parseCommand('/delete 3')).toEqual({ command: 'delete', args: '3' });
    expect(adapter.parseCommand('/quit')).toEqual({ command: 'quit', args: '' });
    expect(adapter.parseCommand('/memory some-long-id')).toEqual({ command: 'memory', args: 'some-long-id' });
  });
});

describe('CLI Arg Parsing Integration', () => {
  it('parses full CLI invocation args', () => {
    const args = parseArgs(['--adapter=cli', '--verbose', '我們該用 monorepo 嗎？']);
    expect(args.adapter).toBe('cli');
    expect(args.verbose).toBe(true);
    expect(args.message).toBe('我們該用 monorepo 嗎？');
  });

  it('defaults to telegram without flags', () => {
    const args = parseArgs([]);
    expect(args.adapter).toBe('telegram');
    expect(args.verbose).toBe(false);
    expect(args.message).toBeUndefined();
  });
});
