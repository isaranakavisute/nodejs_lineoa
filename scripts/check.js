// Verify LINE credentials and show the channel's current webhook settings.
// Usage: npm run check
import { client } from '../src/line.js';

try {
  const bot = await client.getBotInfo();
  console.log('Channel access token: OK');
  console.log(`  Bot name:   ${bot.displayName}`);
  console.log(`  Basic ID:   ${bot.basicId}`);
  console.log(`  User ID:    ${bot.userId}`);
  console.log(`  Chat mode:  ${bot.chatMode}`);
  console.log(`  Read mark:  ${bot.markAsReadMode}`);
} catch (err) {
  console.error('Channel access token: FAILED', err.status ?? '', err.body ?? err.message);
  process.exit(1);
}

try {
  const webhook = await client.getWebhookEndpoint();
  console.log('Webhook settings:');
  console.log(`  URL:          ${webhook.endpoint || '(not set)'}`);
  console.log(`  Use webhook:  ${webhook.active}`);
} catch (err) {
  if (err.status === 404) {
    console.log('Webhook settings: URL not set yet (LINE Developers Console > Messaging API > Webhook URL)');
  } else {
    console.error('Could not read webhook settings:', err.status ?? '', err.body ?? err.message);
  }
}
