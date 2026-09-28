// Preview today's news digest, or send it to all subscribers right now.
// Usage: npm run news -- [language]     (preview only)
//        npm run news -- --send         (push to every subscriber)
import { config } from '../src/config.js';
import { getDigest } from '../src/news.js';
import { sendNewsToSubscribers } from '../src/newsScheduler.js';
import { allSubscriptions } from '../src/store.js';

const args = process.argv.slice(2);

if (args.includes('--send')) {
  console.log(`Sending to ${allSubscriptions().length} subscriber(s)…`);
  await sendNewsToSubscribers();
} else {
  const language = args.join(' ') || config.news.defaultLanguage;
  const started = Date.now();
  const digest = await getDigest(language);
  console.log(digest);
  console.error(`\n(${config.anthropic.model}, ${digest.length} chars, ${Math.round((Date.now() - started) / 1000)} s)`);
}
