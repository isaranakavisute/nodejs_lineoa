import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { config } from './config.js';
import { client } from './line.js';
import { fetchEvents, dueForAlert, formatAlert, alertKey } from './calendar.js';
import { NotSignedIn } from './microsoft.js';

// Meetings already alerted, saved to disk so a restart doesn't alert twice: { [key]: startIso }
const alertedFile = path.join(config.dataDir, 'calendar-alerted.json');

function loadAlerted() {
  try {
    return JSON.parse(fs.readFileSync(alertedFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveAlerted(alerted, now) {
  // Forget meetings that started more than a day ago.
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const kept = Object.fromEntries(Object.entries(alerted).filter(([, start]) => Date.parse(start) > dayAgo));
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(`${alertedFile}.tmp`, JSON.stringify(kept));
  fs.renameSync(`${alertedFile}.tmp`, alertedFile);
}

let running = false;
let lastSignInWarning = 0;

export async function checkCalendar(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const windowEnd = new Date(now.getTime() + (config.calendar.leadMinutes + 5) * 60 * 1000);
    const events = await fetchEvents(now, windowEnd);
    const alerted = loadAlerted();
    const due = dueForAlert(events, now, new Set(Object.keys(alerted)));
    if (due.length === 0) return;

    // One push message for everything due, to save LINE message quota.
    await client.pushMessage({ to: config.calendar.alertTo, messages: [{ type: 'text', text: formatAlert(due, now) }] });
    for (const event of due) alerted[alertKey(event)] = event.start.toISOString();
    saveAlerted(alerted, now);
    console.log(`Calendar alert sent for ${due.length} meeting(s)`);
  } catch (err) {
    if (err instanceof NotSignedIn) {
      // Don't flood the logs every minute; remind hourly.
      if (Date.now() - lastSignInWarning > 60 * 60 * 1000) {
        console.error(`Calendar alerts paused: ${err.message}`);
        lastSignInWarning = Date.now();
      }
    } else {
      console.error('Calendar check failed:', err.status ?? '', err.body ?? err.message);
    }
  } finally {
    running = false;
  }
}

export function startCalendarSchedule() {
  cron.schedule('* * * * *', () => checkCalendar());
  console.log(`Calendar alerts on: ${config.calendar.leadMinutes} min before each meeting`);
}
