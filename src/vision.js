import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { blobClient } from './line.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Claude accepts images up to 5 MB each.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// LINE text messages are capped at 5,000 characters.
const LINE_TEXT_LIMIT = 5000;

const SYSTEM_PROMPT = `You are a helpful assistant in a LINE chat. The user has sent an image and is asking about it.
Answer in the same language the user writes in. Keep answers concise and easy to read on a phone: short paragraphs, no Markdown headings or tables. If the image doesn't show what's needed to answer, say so.`;

export class ImageTooLarge extends Error {}
export class UnsupportedImage extends Error {}
export class AnswerRefused extends Error {}

function detectMediaType(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

// Returns a Claude image content block for an image message sent to the bot.
export async function downloadImage(message) {
  if (message.contentProvider?.type === 'external') {
    return { type: 'image', source: { type: 'url', url: message.contentProvider.originalContentUrl } };
  }

  const stream = await blobClient.getMessageContent(message.id);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      stream.destroy();
      throw new ImageTooLarge();
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const mediaType = detectMediaType(buffer);
  if (!mediaType) throw new UnsupportedImage();

  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
}

// messages: the conversation so far, starting with a user turn that contains the image.
export async function askAboutImage(messages) {
  const response = await anthropic.beta.messages.create({
    model: config.anthropic.model,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    // Caches the image so follow-up questions don't pay for it again.
    cache_control: { type: 'ephemeral' },
    // If the model declines, the API retries on a fallback model within the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages,
  });

  if (response.stop_reason === 'refusal') {
    throw new AnswerRefused(response.stop_details?.explanation ?? 'Refused');
  }

  const answer = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  return answer.slice(0, LINE_TEXT_LIMIT);
}
