import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// LINE text messages are capped at 5,000 characters.
const LINE_TEXT_LIMIT = 5000;

const SYSTEM_PROMPT = `You are Claude, a helpful assistant chatting with someone through a LINE Official Account.
Reply in the same language the user writes in. Keep replies concise and easy to read on a phone: short paragraphs or simple lists, and no Markdown headings, bold markers, or tables, since LINE shows them as raw symbols.`;

export class ChatRefused extends Error {}

// messages: the conversation so far, ending with the user's latest message.
export async function chat(messages) {
  const response = await anthropic.beta.messages.create({
    model: config.anthropic.model,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    // Caches the conversation so each new message only pays full price for what's new.
    cache_control: { type: 'ephemeral' },
    // If the model declines, the API retries on a fallback model within the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages,
  });

  if (response.stop_reason === 'refusal') {
    throw new ChatRefused(response.stop_details?.explanation ?? 'Refused');
  }

  const answer = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  return answer.slice(0, LINE_TEXT_LIMIT);
}
