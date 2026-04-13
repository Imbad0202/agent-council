import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliAdapter } from '../../src/adapters/cli.js';
import type { RichMetadata } from '../../src/adapters/types.js';

describe('CliAdapter', () => {
  describe('implements InputAdapter + OutputAdapter', () => {
    it('has start and stop methods', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
    });

    it('has send and sendSystem methods', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.sendSystem).toBe('function');
    });

    it('stores verbose config', () => {
      const adapter = new CliAdapter({ verbose: true });
      expect(adapter.verbose).toBe(true);
    });

    it('stores verbose=false config', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(adapter.verbose).toBe(false);
    });
  });

  describe('formatAgentMessage — compact (verbose=false)', () => {
    it('includes agent name and content', () => {
      const adapter = new CliAdapter({ verbose: false });
      const meta: RichMetadata = { agentName: 'huahua' };
      const result = adapter.formatAgentMessage('Hello world', meta);
      expect(result).toContain('huahua');
      expect(result).toContain('Hello world');
    });

    it('includes role tag when role is present', () => {
      const adapter = new CliAdapter({ verbose: false });
      const meta: RichMetadata = { agentName: 'binbin', role: 'advocate' };
      const result = adapter.formatAgentMessage('My message', meta);
      expect(result).toContain('binbin');
      expect(result).toContain('[advocate]');
      expect(result).toContain('My message');
    });

    it('does not include emotion/stance metadata when not verbose', () => {
      const adapter = new CliAdapter({ verbose: false });
      const meta: RichMetadata = {
        agentName: 'huahua',
        emotion: 'assertive',
        stanceShift: 'hardened',
      };
      const result = adapter.formatAgentMessage('Assertive text', meta);
      expect(result).not.toContain('Emotion:');
      expect(result).not.toContain('Stance:');
    });

    it('does not show meta line when verbose but no emotion/stanceShift', () => {
      const adapter = new CliAdapter({ verbose: true });
      const meta: RichMetadata = { agentName: 'facilitator' };
      const result = adapter.formatAgentMessage('Neutral message', meta);
      expect(result).not.toContain('Emotion:');
      expect(result).not.toContain('Stance:');
    });

    it('formats unknown agent name with content', () => {
      const adapter = new CliAdapter({ verbose: false });
      const meta: RichMetadata = { agentName: 'UnknownAgent' };
      const result = adapter.formatAgentMessage('Some text', meta);
      expect(result).toContain('UnknownAgent');
      expect(result).toContain('Some text');
    });

    it('matches agent color by partial name match (e.g. huahua in display name)', () => {
      const adapter = new CliAdapter({ verbose: false });
      const meta: RichMetadata = { agentName: 'Agent huahua' };
      const result = adapter.formatAgentMessage('Partial match', meta);
      expect(result).toContain('Agent huahua');
      expect(result).toContain('Partial match');
    });
  });

  describe('formatAgentMessage — verbose mode', () => {
    it('includes emotion in meta line when verbose and emotion set', () => {
      const adapter = new CliAdapter({ verbose: true });
      const meta: RichMetadata = {
        agentName: 'huahua',
        emotion: 'assertive',
      };
      const result = adapter.formatAgentMessage('Bold claim', meta);
      expect(result).toContain('Emotion:');
      expect(result).toContain('assertive');
    });

    it('includes stance in meta line when verbose and stanceShift set', () => {
      const adapter = new CliAdapter({ verbose: true });
      const meta: RichMetadata = {
        agentName: 'binbin',
        stanceShift: 'softened',
      };
      const result = adapter.formatAgentMessage('Gentler now', meta);
      expect(result).toContain('Stance:');
      expect(result).toContain('softened');
    });

    it('shows neutral/unchanged defaults when emotion/stance are absent but verbose', () => {
      const adapter = new CliAdapter({ verbose: true });
      const meta: RichMetadata = {
        agentName: 'huahua',
        emotion: 'neutral',
        stanceShift: 'unchanged',
      };
      const result = adapter.formatAgentMessage('Steady', meta);
      expect(result).toContain('neutral');
      expect(result).toContain('unchanged');
    });
  });

  describe('isCommand', () => {
    it('returns true for /help', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(adapter.isCommand('/help')).toBe(true);
    });

    it('returns true for /quit', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(adapter.isCommand('/quit')).toBe(true);
    });

    it('returns false for regular text', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(adapter.isCommand('hello world')).toBe(false);
    });

    it('returns false for empty string', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(adapter.isCommand('')).toBe(false);
    });

    it('returns false for text starting with non-slash', () => {
      const adapter = new CliAdapter({ verbose: false });
      expect(adapter.isCommand('not a command')).toBe(false);
    });
  });

  describe('parseCommand', () => {
    it('parses command without args', () => {
      const adapter = new CliAdapter({ verbose: false });
      const result = adapter.parseCommand('/quit');
      expect(result.command).toBe('quit');
      expect(result.args).toBe('');
    });

    it('parses command with args', () => {
      const adapter = new CliAdapter({ verbose: false });
      const result = adapter.parseCommand('/topic new discussion');
      expect(result.command).toBe('topic');
      expect(result.args).toBe('new discussion');
    });

    it('trims args', () => {
      const adapter = new CliAdapter({ verbose: false });
      const result = adapter.parseCommand('/topic   extra spaces  ');
      expect(result.command).toBe('topic');
      expect(result.args).toBe('extra spaces');
    });

    it('parses /help with no args', () => {
      const adapter = new CliAdapter({ verbose: false });
      const result = adapter.parseCommand('/help');
      expect(result.command).toBe('help');
      expect(result.args).toBe('');
    });

    it('parses /verbose toggle', () => {
      const adapter = new CliAdapter({ verbose: false });
      const result = adapter.parseCommand('/verbose on');
      expect(result.command).toBe('verbose');
      expect(result.args).toBe('on');
    });
  });

  describe('toggleVerbose', () => {
    it('toggles from false to true', () => {
      const adapter = new CliAdapter({ verbose: false });
      adapter.toggleVerbose();
      expect(adapter.verbose).toBe(true);
    });

    it('toggles from true to false', () => {
      const adapter = new CliAdapter({ verbose: true });
      adapter.toggleVerbose();
      expect(adapter.verbose).toBe(false);
    });

    it('double toggle returns to original', () => {
      const adapter = new CliAdapter({ verbose: false });
      adapter.toggleVerbose();
      adapter.toggleVerbose();
      expect(adapter.verbose).toBe(false);
    });
  });

  describe('sendSystem', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      writeSpy.mockRestore();
    });

    it('writes the content to stdout', async () => {
      const adapter = new CliAdapter({ verbose: false });
      await adapter.sendSystem('System message here');

      const written = writeSpy.mock.calls.map(call => call[0]).join('');
      expect(written).toContain('System message here');
    });

    it('appends a newline', async () => {
      const adapter = new CliAdapter({ verbose: false });
      await adapter.sendSystem('System message');

      const written = writeSpy.mock.calls.map(call => call[0]).join('');
      expect(written).toContain('\n');
    });

    it('sends different system messages correctly', async () => {
      const adapter = new CliAdapter({ verbose: false });
      await adapter.sendSystem('Council session started');

      const written = writeSpy.mock.calls.map(call => call[0]).join('');
      expect(written).toContain('Council session started');
    });
  });

  describe('send', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      writeSpy.mockRestore();
    });

    it('writes formatted agent message to stdout', async () => {
      const adapter = new CliAdapter({ verbose: false });
      const meta: RichMetadata = { agentName: 'huahua' };
      await adapter.send('huahua', 'My response', meta);

      const written = writeSpy.mock.calls.map(call => call[0]).join('');
      expect(written).toContain('huahua');
      expect(written).toContain('My response');
    });

    it('appends newline after message', async () => {
      const adapter = new CliAdapter({ verbose: false });
      const meta: RichMetadata = { agentName: 'binbin' };
      await adapter.send('binbin', 'Hello', meta);

      const written = writeSpy.mock.calls.map(call => call[0]).join('');
      expect(written).toContain('\n');
    });
  });
});
