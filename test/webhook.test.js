import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SECRET = 'test-channel-secret';
process.env.NODE_ENV = 'test';
process.env.LINE_CHANNEL_SECRET = SECRET;
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';

const { app } = await import('../src/app.js');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => server.close());

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64');
}

test('health check returns ok', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('webhook accepts a correctly signed request (LINE "Verify" sends empty events)', async () => {
  const body = JSON.stringify({ destination: 'U123', events: [] });
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sign(body) },
    body,
  });
  assert.equal(res.status, 200);
});

test('webhook rejects an invalid signature', async () => {
  const body = JSON.stringify({ destination: 'U123', events: [] });
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'invalid' },
    body,
  });
  assert.equal(res.status, 401);
});
