import { describe, it, expect } from 'vitest';
import { createCouncilMessageFromTelegram, formatAgentReply } from '../../src/telegram/handlers.js';

describe('handlers', () => {
  describe('createCouncilMessageFromTelegram', () => {
    it('converts a Telegram message to CouncilMessage', () => {
      const telegramMsg = {
        message_id: 42,
        text: 'What do you think about this approach?',
        date: 1712900000,
        from: { id: 601357059, first_name: 'Imbad' },
      };

      const msg = createCouncilMessageFromTelegram(telegramMsg);
      expect(msg.id).toBe('tg-42');
      expect(msg.role).toBe('human');
      expect(msg.content).toBe('What do you think about this approach?');
      expect(msg.timestamp).toBe(1712900000000);
    });

    it('passes message_thread_id as threadId', () => {
      const telegramMsg = {
        message_id: 44,
        text: 'Hello from a topic',
        date: 1712900000,
        from: { id: 601357059, first_name: 'Test' },
        message_thread_id: 99,
      };
      const msg = createCouncilMessageFromTelegram(telegramMsg);
      expect(msg.threadId).toBe(99);
    });

    it('handles message without text', () => {
      const telegramMsg = {
        message_id: 43,
        date: 1712900000,
        from: { id: 601357059, first_name: 'Imbad' },
      };

      const msg = createCouncilMessageFromTelegram(telegramMsg);
      expect(msg.content).toBe('');
    });
  });

  describe('formatAgentReply', () => {
    it('prefixes reply with agent name', () => {
      const reply = formatAgentReply('huahua', '花花', 'I disagree because...');
      expect(reply).toContain('花花');
      expect(reply).toContain('I disagree because...');
    });
  });
});
