import express from 'express';
import { middleware, HTTPFetchError, SignatureValidationFailed } from '@line/bot-sdk';
import { config } from './config.js';
import { handleEvent } from './handlers.js';

export const app = express();

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// LINE middleware verifies the X-Line-Signature header and parses the body.
// Do not add express.json() before this route; the raw body is needed for signature validation.
app.post('/webhook', middleware({ channelSecret: config.line.channelSecret }), async (req, res) => {
  // Respond immediately so LINE doesn't time out; process events afterwards.
  res.sendStatus(200);

  const results = await Promise.allSettled(req.body.events.map(handleEvent));
  for (const result of results) {
    if (result.status === 'rejected') {
      const err = result.reason;
      if (err instanceof HTTPFetchError) {
        console.error(`LINE API error ${err.status}:`, err.body);
      } else {
        console.error('Event handler error:', err);
      }
    }
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SignatureValidationFailed) {
    res.status(401).send(err.message);
    return;
  }
  console.error(err);
  res.status(500).end();
});
