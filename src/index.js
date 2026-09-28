import { app } from './app.js';
import { config } from './config.js';
import { startNewsSchedule } from './newsScheduler.js';

const server = app.listen(config.port, () => {
  console.log(`LINE OA webhook server listening on http://localhost:${config.port}`);
  console.log(`Webhook endpoint: POST /webhook`);
});

startNewsSchedule();

// Shut down cleanly on `docker stop` / Ctrl+C.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
