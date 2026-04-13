import { describe, it, expectTypeOf } from 'vitest';
import type {
  AdapterMessage,
  RichMetadata,
  InputAdapter,
  OutputAdapter,
  Adapter,
} from '../../src/adapters/types.js';

describe('AdapterMessage', () => {
  it('accepts content only', () => {
    const msg: AdapterMessage = { content: 'hello' };
    expectTypeOf(msg).toMatchTypeOf<AdapterMessage>();
  });

  it('accepts content with threadId', () => {
    const msg: AdapterMessage = { content: 'hello', threadId: 42 };
    expectTypeOf(msg).toMatchTypeOf<AdapterMessage>();
  });

  it('threadId is optional', () => {
    expectTypeOf<AdapterMessage['threadId']>().toEqualTypeOf<number | undefined>();
  });
});

describe('RichMetadata', () => {
  it('accepts agentName only (required field)', () => {
    const meta: RichMetadata = { agentName: 'Advocate' };
    expectTypeOf(meta).toMatchTypeOf<RichMetadata>();
  });

  it('accepts all fields', () => {
    const meta: RichMetadata = {
      agentName: 'Critic',
      role: 'critic',
      emotion: 'assertive',
      intensity: 0.8,
      stanceShift: 'hardened',
      replyingTo: 'msg-123',
      isSystem: false,
    };
    expectTypeOf(meta).toMatchTypeOf<RichMetadata>();
  });

  it('supports all emotion values', () => {
    const emotions: RichMetadata['emotion'][] = [
      'neutral',
      'assertive',
      'questioning',
      'conceding',
      'thoughtful',
      'frustrated',
      undefined,
    ];
    expectTypeOf(emotions).toEqualTypeOf<
      ('neutral' | 'assertive' | 'questioning' | 'conceding' | 'thoughtful' | 'frustrated' | undefined)[]
    >();
  });

  it('supports all stanceShift values', () => {
    const shifts: RichMetadata['stanceShift'][] = [
      'hardened',
      'softened',
      'unchanged',
      undefined,
    ];
    expectTypeOf(shifts).toEqualTypeOf<('hardened' | 'softened' | 'unchanged' | undefined)[]>();
  });

  it('isSystem flag is optional boolean', () => {
    expectTypeOf<RichMetadata['isSystem']>().toEqualTypeOf<boolean | undefined>();
  });
});

describe('InputAdapter', () => {
  it('has start and stop methods', () => {
    expectTypeOf<InputAdapter['start']>().toBeFunction();
    expectTypeOf<InputAdapter['stop']>().toBeFunction();
  });

  it('start accepts a callback and returns Promise<void>', () => {
    expectTypeOf<InputAdapter['start']>().parameters.toEqualTypeOf<
      [(msg: AdapterMessage) => void]
    >();
    expectTypeOf<InputAdapter['start']>().returns.toEqualTypeOf<Promise<void>>();
  });

  it('stop returns Promise<void>', () => {
    expectTypeOf<InputAdapter['stop']>().returns.toEqualTypeOf<Promise<void>>();
  });
});

describe('OutputAdapter', () => {
  it('has send and sendSystem methods', () => {
    expectTypeOf<OutputAdapter['send']>().toBeFunction();
    expectTypeOf<OutputAdapter['sendSystem']>().toBeFunction();
  });

  it('send has correct signature', () => {
    expectTypeOf<OutputAdapter['send']>().parameters.toEqualTypeOf<
      [agentId: string, content: string, metadata: RichMetadata, threadId?: number]
    >();
    expectTypeOf<OutputAdapter['send']>().returns.toEqualTypeOf<Promise<void>>();
  });

  it('sendSystem has correct signature', () => {
    expectTypeOf<OutputAdapter['sendSystem']>().parameters.toEqualTypeOf<
      [content: string, threadId?: number]
    >();
    expectTypeOf<OutputAdapter['sendSystem']>().returns.toEqualTypeOf<Promise<void>>();
  });
});

describe('Adapter (combined)', () => {
  it('Adapter extends both InputAdapter and OutputAdapter', () => {
    expectTypeOf<Adapter>().toMatchTypeOf<InputAdapter>();
    expectTypeOf<Adapter>().toMatchTypeOf<OutputAdapter>();
  });

  it('a concrete object satisfies Adapter', () => {
    const adapter: Adapter = {
      start: async (_onMessage) => {},
      stop: async () => {},
      send: async (_agentId, _content, _metadata, _threadId) => {},
      sendSystem: async (_content, _threadId) => {},
    };
    expectTypeOf(adapter).toMatchTypeOf<Adapter>();
  });
});
