// Send a push message to a user, group, or room.
// Usage: npm run push -- <to> "<message>"
import { client } from '../src/line.js';

const [to, ...words] = process.argv.slice(2);
const text = words.join(' ');

if (!to || !text) {
  console.error('Usage: npm run push -- <userId|groupId|roomId> "<message>"');
  process.exit(1);
}

try {
  await client.pushMessage({ to, messages: [{ type: 'text', text }] });
  console.log(`Sent to ${to}`);
} catch (err) {
  console.error('Push failed:', err.status ?? '', err.body ?? err.message);
  process.exit(1);
}
