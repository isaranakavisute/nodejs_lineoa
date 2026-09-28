// One-time sign-in to your Outlook.com / Hotmail account so the bot can read your calendar.
// Usage: npm run microsoft-login
//   In Docker: docker compose exec app npm run microsoft-login
import { config } from '../src/config.js';
import { signInWithDeviceCode } from '../src/microsoft.js';
import { fetchEvents, formatAgenda, endOfToday } from '../src/calendar.js';

if (!config.calendar.clientId) {
  console.error('Set MICROSOFT_CLIENT_ID in .env first (see README: Calendar alerts).');
  process.exit(1);
}

try {
  await signInWithDeviceCode((message) => console.log(`\n${message}\n`));
  console.log('✅ Signed in. Checking your calendar…\n');
  const now = new Date();
  console.log(formatAgenda(await fetchEvents(now, endOfToday(now)), now));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
