import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineoa-menu-'));
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';
// Messages that fall through to Claude chat must never reach the real API in tests.
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
process.env.DATA_DIR = dataDir;
process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.CALENDAR_ALERT_TO = 'Uowner';
process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
process.env.FACEBOOK_PAGE_ID = '111';
process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'page-token';
fs.writeFileSync(path.join(dataDir, 'microsoft-token.json'), JSON.stringify({ refreshToken: 'r', scope: 'offline_access Calendars.ReadWrite Mail.Send Mail.Read' }));

const { handleEvent } = await import('../src/handlers.js');
const { client, blobClient } = await import('../src/line.js');

// Captures every bot reply: its text and the labels of its buttons.
const replies = [];
client.replyMessage = async ({ messages }) => {
  const m = messages[0];
  replies.push({ text: m.text, buttons: (m.quickReply?.items ?? []).map((i) => i.action) });
};
client.showLoadingAnimation = async () => ({});
blobClient.getMessageContent = async () => Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])]);

// Fake Microsoft and Facebook APIs; records every write.
const writes = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === 'login.microsoftonline.com') return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
  if (init.method && init.method !== 'GET') writes.push({ host: u.hostname, path: u.pathname, body: init.body });
  if (u.pathname === '/v1.0/me/events') return new Response(JSON.stringify({ id: 'evt1' }));
  if (u.pathname === '/v1.0/me/sendMail') return new Response(null, { status: 202 });
  if (u.hostname === 'graph.facebook.com') return new Response(JSON.stringify(u.pathname.endsWith('/photos') ? { id: '9', post_id: '111_9' } : { id: '111_1' }));
  return new Response(JSON.stringify({ value: [] }));
};

const owner = { type: 'user', userId: 'Uowner' };
const text = (t, source = owner) => handleEvent({ type: 'message', replyToken: 'r', source, message: { id: '1', type: 'text', text: t } });
const photo = () => handleEvent({ type: 'message', replyToken: 'r', source: owner, message: { id: '2', type: 'image', contentProvider: { type: 'line' } } });
const tap = (data, source = owner) => handleEvent({ type: 'postback', replyToken: 'r', source, postback: { data } });
// Taps the button with this label on the last reply.
const tapButton = (label) => {
  const action = replies.at(-1).buttons.find((b) => b.label === label);
  assert.ok(action, `button "${label}" should be on: ${replies.at(-1).text}`);
  return action.type === 'message' ? text(action.text) : tap(action.data);
};
const last = () => replies.at(-1);

test('/menu and menu tiles show buttons; other users get nothing private', async () => {
  await text('/menu');
  assert.deepEqual(last().buttons.map((b) => b.label), ['📬 Inbox', '✉️ Email', '📅 Calendar', '📘 Facebook', '💬 Chat / Translate', '❓ Help']);
  await tap('menu=calendar');
  assert.deepEqual(last().buttons.map((b) => b.label), ["📋 Today's meetings", '➕ Add a meeting', '↩️ Undo last added', '❓ Calendar help']);

  const before = replies.length;
  await tap('menu=calendar', { type: 'user', userId: 'Ustranger' });
  assert.equal(replies.length, before, 'strangers’ taps are ignored');
  await text('/menu', { type: 'user', userId: 'Ustranger' });
  assert.match(last().text, /Claude on LINE/);
  assert.equal(last().buttons.length, 0);
});

test('guided email: asks each part, validates the address, then Send button sends', async () => {
  await tap('flow=email');
  assert.match(last().text, /Who should I send it to/);
  await text('not-an-address');
  assert.match(last().text, /isn't an email address/);
  await text('friend@example.com');
  assert.match(last().text, /subject/);
  await text('Lunch');
  assert.match(last().text, /Type your message/);
  await text('Free at 12?\nSecond line');
  assert.match(last().text, /Ready to send[\s\S]*friend@example.com[\s\S]*Lunch[\s\S]*Free at 12\?\nSecond line/);
  assert.equal(writes.length, 0, 'nothing sent before tapping Send');
  await tapButton('✅ Send');
  assert.match(last().text, /Email sent to friend@example.com/);
  assert.equal(writes.at(-1).path, '/v1.0/me/sendMail');
});

test('guided meeting: buttons for time and length, confirmation before adding', async () => {
  const count = writes.length;
  await tap('flow=meet');
  assert.ok(last().buttons.some((b) => b.label === 'In 1 hour'));
  await tapButton('In 1 hour');
  assert.match(last().text, /How long/);
  await tapButton('30 min');
  assert.match(last().text, /called/);
  await text('Design review');
  assert.match(last().text, /Add this meeting\?[\s\S]*Design review[\s\S]*30 min/);
  assert.equal(writes.length, count, 'nothing added before tapping Add');
  await tapButton('✅ Add');
  assert.match(last().text, /Added to your calendar[\s\S]*Design review/);
  assert.equal(writes.at(-1).path, '/v1.0/me/events');
});

test('guided Facebook photo: camera/gallery buttons, caption, then Post', async () => {
  await tap('menu=facebook');
  await tapButton('📷 Photo post');
  assert.deepEqual(last().buttons.map((b) => b.type), ['camera', 'cameraRoll', 'postback']);
  await text('oops, text instead');
  assert.match(last().text, /need a photo first/);
  await photo();
  assert.match(last().text, /Got the photo[\s\S]*caption/);
  await tapButton('No caption');
  assert.match(last().text, /Ready to post a photo[\s\S]*no caption/);
  await tapButton('✅ Post');
  assert.match(last().text, /Posted to your Facebook Page/);
  assert.equal(writes.at(-1).path, '/v23.0/111/photos');
});

test('Cancel stops a flow, and typing a command abandons it', async () => {
  const count = writes.length;
  await tap('flow=fbtext');
  await tapButton('❌ Cancel');
  assert.match(last().text, /Cancelled/);
  await text('This should not be posted');
  assert.equal(writes.length, count);

  await tap('flow=email');
  await text('/help');
  await text('friend@example.com'); // no longer an answer to the email flow
  assert.equal(writes.length, count);
});

test('language flow and quick language buttons', async () => {
  await tap('menu=modes');
  await tapButton('🌐 Other language');
  await text('Vietnamese');
  assert.match(last().text, /translated into Vietnamese/);
});
