import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineoa-mail-'));
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DATA_DIR = dataDir;
process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.CALENDAR_ALERT_TO = 'Uowner';

const { parseEmailCommand } = await import('../src/mail.js');
const { handleEvent } = await import('../src/handlers.js');
const { client } = await import('../src/line.js');

test('parses recipients, subject and multi-line body', () => {
  const draft = parseEmailCommand('a@example.com, b@example.org\nSubject: Hello\nLine one\nLine two');
  assert.deepEqual(draft, { to: ['a@example.com', 'b@example.org'], subject: 'Hello', body: 'Line one\nLine two' });
});

test('rejects bad addresses and missing parts', () => {
  assert.equal(parseEmailCommand('not-an-email\nHi\nBody').error, 'address');
  assert.equal(parseEmailCommand('a@example.com\nHi').error, 'format');
  assert.equal(parseEmailCommand('a@example.com').error, 'format');
});

test('shows a preview, sends only after /send, and /cancel discards', async () => {
  fs.writeFileSync(path.join(dataDir, 'microsoft-token.json'), JSON.stringify({ refreshToken: 'r', scope: 'offline_access Calendars.ReadWrite Mail.Send' }));
  const replies = [];
  const graphCalls = [];
  client.replyMessage = async ({ messages }) => replies.push(messages[0].text);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 }));
    }
    graphCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: 202 });
  };
  const send = (text, userId = 'Uowner') =>
    handleEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId }, message: { id: '1', type: 'text', text } });

  try {
    await send('/email friend@example.com\nLunch\nSee you at noon?');
    assert.match(replies.at(-1), /Ready to send[\s\S]*friend@example.com[\s\S]*Lunch[\s\S]*See you at noon\?[\s\S]*\/send/);
    assert.equal(graphCalls.length, 0, 'nothing is sent before /send');

    await send('/send', 'Ustranger');
    assert.equal(graphCalls.length, 0, 'other users cannot send');

    await send('/send');
    assert.match(replies.at(-1), /Email sent to friend@example.com/);
    assert.equal(graphCalls.length, 1);
    assert.match(graphCalls[0].url, /\/me\/sendMail$/);
    assert.equal(graphCalls[0].body.message.toRecipients[0].emailAddress.address, 'friend@example.com');

    await send('/send');
    assert.equal(graphCalls.length, 1, 'a draft is sent only once');

    await send('/email friend@example.com\nDraft\nNever mind');
    await send('/cancel');
    await send('/send');
    assert.equal(graphCalls.length, 1, 'cancelled draft is not sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
