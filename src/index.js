import { app } from './app.js';
import { config } from './config.js';
import { startNewsSchedule } from './newsScheduler.js';
import { startCalendarSchedule } from './calendarScheduler.js';

const server = app.listen(config.port, () => {
  console.log(`LINE OA webhook server listening on http://localhost:${config.port}`);
  console.log(`Webhook endpoint: POST /webhook`);
});

if (config.news.scheduleEnabled) {
  startNewsSchedule();
} else {
  console.log('Morning news schedule is off (set NEWS_SCHEDULE_ENABLED=true to turn it on)');
}

if (config.calendar.clientId && config.calendar.alertTo) {
  startCalendarSchedule();
} else {
  console.log('Calendar alerts are off (set MICROSOFT_CLIENT_ID and CALENDAR_ALERT_TO to turn them on)');
}

// Shut down cleanly on `docker stop` / Ctrl+C.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
