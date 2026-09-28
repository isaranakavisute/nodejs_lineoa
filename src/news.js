import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// LINE text messages are capped at 5,000 characters.
const LINE_TEXT_LIMIT = 5000;
// Server-side web search pauses after 10 internal steps; resume at most this many times.
const MAX_CONTINUATIONS = 5;

// Today's digests, keyed by `${date}|${language}`, so /news and the morning push reuse one generation.
const cache = new Map();

export class DigestRefused extends Error {}

export function todayLabel() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.news.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
}

function prompt(date, language) {
  return `Today is ${date} (${config.news.timezone}). Search the web for today's most important world news from the past 24 hours and write a short morning briefing.

Pick the ${config.news.storyCount} stories with the greatest global significance. Cover a mix of regions and topics (politics, economy, conflict, science, climate, technology) rather than several angles on one story. Use reputable news sources and only include stories you found in your searches.

Write the whole briefing in ${language}, as plain text for a LINE chat message (no Markdown: no #, **, or tables). Use exactly this layout:

🌍 [the words "Top world news" in ${language}] — [today's date in ${language}]

1️⃣ [Headline]
[One or two sentence summary.]
🔗 [Source name]: [URL]

(and so on for each story, with a blank line between stories)

Keep the whole briefing under 4,000 characters. Reply with the briefing only, with no introduction or closing remarks.`;
}

// Only the text after the last search result is the finished briefing; earlier text is the model narrating its searches.
function finalText(content) {
  let lastToolResult = -1;
  content.forEach((block, i) => {
    if (block.type === 'web_search_tool_result') lastToolResult = i;
  });
  return content
    .slice(lastToolResult + 1)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

async function generateDigest(language) {
  const messages = [{ role: 'user', content: prompt(todayLabel(), language) }];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const response = await anthropic.beta.messages.create({
      model: config.anthropic.model,
      max_tokens: 16000,
      // If the model declines, the API retries on a fallback model within the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages,
    });

    if (response.stop_reason === 'refusal') {
      throw new DigestRefused(response.stop_details?.explanation ?? 'Refused');
    }
    if (response.stop_reason === 'pause_turn') {
      // Send the partial turn back unchanged; the server resumes where it stopped.
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    return finalText(response.content).slice(0, LINE_TEXT_LIMIT);
  }

  throw new Error(`News search did not finish after ${MAX_CONTINUATIONS} continuations`);
}

export async function getDigest(language) {
  const key = `${todayLabel()}|${language.toLowerCase()}`;
  if (!cache.has(key)) {
    // Cache the promise so concurrent requests share one generation; drop it if it fails.
    const pending = generateDigest(language).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, pending);
    for (const oldKey of cache.keys()) {
      if (!oldKey.startsWith(`${todayLabel()}|`)) cache.delete(oldKey);
    }
  }
  return cache.get(key);
}
