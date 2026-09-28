import cron from 'node-cron';
import { config } from './config.js';
import { client } from './line.js';
import { getDigest } from './news.js';
import { allSubscriptions } from './store.js';

// Generates one digest per language and pushes it to every subscriber.
export async function sendNewsToSubscribers() {
  const subscriptions = allSubscriptions();
  const byLanguage = Map.groupBy(subscriptions, (sub) => sub.language);
  let sent = 0;

  for (const [language, subs] of byLanguage) {
    let digest;
    try {
      digest = await getDigest(language);
    } catch (err) {
      console.error(`News digest (${language}) failed:`, err.message);
      continue;
    }
    for (const { chatId } of subs) {
      try {
        await client.pushMessage({ to: chatId, messages: [{ type: 'text', text: digest }] });
        sent++;
      } catch (err) {
        console.error(`News push to ${chatId} failed:`, err.status ?? '', err.body ?? err.message);
      }
    }
  }

  console.log(`Morning news sent to ${sent}/${subscriptions.length} subscribers`);
}

export function startNewsSchedule() {
  const [hour, minute] = config.news.time.split(':').map(Number);
  const expression = `${minute} ${hour} * * *`;
  if (!cron.validate(expression)) {
    throw new Error(`Invalid NEWS_TIME "${config.news.time}", expected HH:MM`);
  }

  cron.schedule(expression, sendNewsToSubscribers, { timezone: config.news.timezone });
  console.log(`Morning news scheduled daily at ${config.news.time} (${config.news.timezone})`);
}
