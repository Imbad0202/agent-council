import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import type { EventMap } from '../../src/events/bus.js';

describe('EventBus', () => {
  describe('emit + on', () => {
    it('handler receives typed payload for message.received', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const payload: EventMap['message.received'] = {
        message: {
          id: 'msg-1',
          role: 'human',
          content: 'Hello council',
          timestamp: Date.now(),
        },
        threadId: 42,
      };

      bus.on('message.received', handler);
      bus.emit('message.received', payload);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('handler receives typed payload for intent.classified', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const payload: EventMap['intent.classified'] = {
        intent: 'deliberation',
        complexity: 'high',
        threadId: 7,
        message: {
          id: 'msg-2',
          role: 'human',
          content: 'Complex question',
          timestamp: Date.now(),
        },
      };

      bus.on('intent.classified', handler);
      bus.emit('intent.classified', payload);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('handler is not called for different event', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on('message.received', handler);
      bus.emit('session.ended', { threadId: 1, topic: 'test', outcome: 'done' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('multiple subscribers', () => {
    it('all subscribers for the same event receive the payload', () => {
      const bus = new EventBus();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      const payload: EventMap['deliberation.started'] = {
        threadId: 10,
        participants: ['agent-a', 'agent-b'],
        roles: { 'agent-a': 'advocate', 'agent-b': 'critic' },
        structure: 'structured',
      };

      bus.on('deliberation.started', handler1);
      bus.on('deliberation.started', handler2);
      bus.on('deliberation.started', handler3);
      bus.emit('deliberation.started', payload);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
      expect(handler3).toHaveBeenCalledOnce();
      expect(handler1).toHaveBeenCalledWith(payload);
      expect(handler2).toHaveBeenCalledWith(payload);
      expect(handler3).toHaveBeenCalledWith(payload);
    });

    it('subscribers for different events are independent', () => {
      const bus = new EventBus();
      const messageHandler = vi.fn();
      const sessionHandler = vi.fn();

      bus.on('message.received', messageHandler);
      bus.on('session.ended', sessionHandler);

      const msgPayload: EventMap['message.received'] = {
        message: { id: 'x', role: 'human', content: 'hi', timestamp: 0 },
        threadId: 1,
      };
      bus.emit('message.received', msgPayload);

      expect(messageHandler).toHaveBeenCalledOnce();
      expect(sessionHandler).not.toHaveBeenCalled();
    });
  });

  describe('once', () => {
    it('fires only once even when emitted multiple times', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.once('convergence.detected', handler);

      bus.emit('convergence.detected', { threadId: 5, angle: 'consensus on X' });
      bus.emit('convergence.detected', { threadId: 5, angle: 'consensus on Y' });
      bus.emit('convergence.detected', { threadId: 5, angle: 'consensus on Z' });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ threadId: 5, angle: 'consensus on X' });
    });

    it('once handler receives correct payload on first call', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const payload: EventMap['session.ending'] = {
        threadId: 99,
        trigger: 'keyword',
      };

      bus.once('session.ending', handler);
      bus.emit('session.ending', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('off', () => {
    it('removes handler so it no longer receives events', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on('pattern.detected', handler);
      bus.emit('pattern.detected', {
        threadId: 3,
        pattern: 'mirror',
        targetAgent: 'agent-b',
      });
      expect(handler).toHaveBeenCalledOnce();

      bus.off('pattern.detected', handler);
      bus.emit('pattern.detected', {
        threadId: 3,
        pattern: 'fake_dissent',
        targetAgent: 'agent-b',
      });

      expect(handler).toHaveBeenCalledOnce(); // still only once
    });

    it('removing one handler leaves others intact', () => {
      const bus = new EventBus();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.on('facilitator.intervened', handler1);
      bus.on('facilitator.intervened', handler2);

      bus.off('facilitator.intervened', handler1);

      const payload: EventMap['facilitator.intervened'] = {
        threadId: 2,
        action: 'challenge',
        content: 'Push back harder',
        targetAgent: 'agent-a',
      };
      bus.emit('facilitator.intervened', payload);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledWith(payload);
    });

    it('removing a non-registered handler does not throw', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      expect(() => {
        bus.off('session.ended', handler);
      }).not.toThrow();
    });
  });

  describe('different event types', () => {
    it('agent.responding payload is correctly typed and passed', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const payload: EventMap['agent.responding'] = {
        threadId: 11,
        agentId: 'alpha',
        role: 'analyst',
      };

      bus.on('agent.responding', handler);
      bus.emit('agent.responding', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('execution.dispatched payload is correctly typed and passed', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const payload: EventMap['execution.dispatched'] = {
        threadId: 20,
        tasks: [
          {
            id: 'task-1',
            description: 'Write tests',
            assignedAgent: 'beta',
            worktreePath: '/tmp/worktree',
            branch: 'feat/task-1',
            status: 'pending',
          },
        ],
      };

      bus.on('execution.dispatched', handler);
      bus.emit('execution.dispatched', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('memory.injected payload is correctly typed and passed', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const payload: EventMap['memory.injected'] = {
        threadId: 15,
        agentId: 'gamma',
        memories: ['We agreed X before', 'Y was deferred'],
      };

      bus.on('memory.injected', handler);
      bus.emit('memory.injected', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('deliberation.ended payload is correctly typed and passed', () => {
      const bus = new EventBus();
      const handler = vi.fn();

      const payload: EventMap['deliberation.ended'] = {
        threadId: 30,
        conclusion: 'We go with option A',
        intent: 'implementation',
      };

      bus.on('deliberation.ended', handler);
      bus.emit('deliberation.ended', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('EventMap blind-review.persist-failed', () => {
    it('has persist-failed event shape', () => {
      const evt: EventMap['blind-review.persist-failed'] = {
        threadId: 1,
        sessionId: 's1',
        error: new Error('disk full'),
      };
      expect(evt.error).toBeInstanceOf(Error);
    });
  });

  describe('max listeners', () => {
    it('does not warn when adding up to 50 listeners', () => {
      const bus = new EventBus();
      const warnSpy = vi.spyOn(process, 'emit');

      for (let i = 0; i < 50; i++) {
        bus.on('message.received', vi.fn());
      }

      // No MaxListenersExceededWarning should have been emitted
      const warnings = warnSpy.mock.calls.filter(
        ([event, warning]) =>
          event === 'warning' &&
          (warning as NodeJS.ErrnoException)?.name === 'MaxListenersExceededWarning',
      );
      expect(warnings).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });
});
