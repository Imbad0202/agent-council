import type { LLMProvider } from '../../types.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { CustomProvider } from './custom.js';

export function createProvider(providerName: string): LLMProvider {
  switch (providerName) {
    case 'claude': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('ANTHROPIC_API_KEY required for Claude provider');
      return new ClaudeProvider(key);
    }
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY required for OpenAI provider');
      return new OpenAIProvider(key);
    }
    case 'google': {
      const key = process.env.GOOGLE_AI_API_KEY;
      if (!key) throw new Error('GOOGLE_AI_API_KEY required for Google provider');
      return new GoogleProvider(key);
    }
    case 'custom': {
      const url = process.env.CUSTOM_PROVIDER_URL;
      if (!url) throw new Error('CUSTOM_PROVIDER_URL required for Custom provider');
      return new CustomProvider(url, process.env.CUSTOM_PROVIDER_API_KEY);
    }
    default:
      throw new Error(`Unknown provider: ${providerName}. Available: claude, openai, google, custom`);
  }
}
