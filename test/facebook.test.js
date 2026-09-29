import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lineoa-fb-'));
process.env.CALENDAR_ALERT_TO = 'Uowner';
process.env.FACEBOOK_PAGE_ID = '61594634443175';
process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'page-token';

const { parseFacebookPost } = await import('../src/facebook.js');
const { handleEvent } = await import('../src/handlers.js');
const { client, blobClient } = await import('../src/line.js');

test('parses post text and picks up the first link', () => {
  assert.deepEqual(parseFacebookPost('  Hello world  '), { message: 'Hello world' });
  assert.deepEqual(parseFacebookPost('New blog post: https://example.com/a and https://b.com'), {
    message: 'New blog post: https://example.com/a and https://b.com', link: 'https://example.com/a',
  });
  assert.equal(parseFacebookPost('   ').error, 'empty');
});

test('previews, publishes only after /post, and only for the owner', async () => {
  const replies = [];
  const calls = [];
  client.replyMessage = async ({ messages }) => replies.push(messages[0].text);
  client.showLoadingAnimation = async () => ({});
  blobClient.getMessageContent = async () => Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method, body: init.body });
    const result = u.pathname.endsWith('/photos') ? { id: '999', post_id: '61594634443175_999' } : { id: '61594634443175_123' };
    return new Response(JSON.stringify(result));
  };
  const send = (message, userId = 'Uowner') =>
    handleEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId }, message: { id: '1', ...message } });
  const text = (t, userId) => send({ type: 'text', text: t }, userId);

  try {
    await text('/fb Hello from LINE!\nSecond line');
    assert.match(replies.at(-1), /Ready to post to your Facebook Page[\s\S]*Hello from LINE![\s\S]*\/post/);
    assert.equal(calls.length, 0, 'nothing is posted before /post');

    await text('/post', 'Ustranger');
    assert.equal(calls.length, 0, 'other users cannot post');

    await text('/post');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/v23.0/61594634443175/feed');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.get('message'), 'Hello from LINE!\nSecond line');
    assert.equal(calls[0].body.get('access_token'), 'page-token');
    assert.match(replies.at(-1), /Posted to your Facebook Page:\nhttps:\/\/www.facebook.com\/61594634443175_123/);

    await text('/post');
    assert.equal(calls.length, 1, 'a draft is posted only once');

    await text('/fb Never mind');
    await text('/cancel');
    assert.match(replies.at(-1), /Discarded: Facebook post/);
    await text('/post');
    assert.equal(calls.length, 1, 'a cancelled draft is not posted');

    await text('/fbphoto No photo yet');
    assert.match(replies.at(-1), /Send me the photo first/);

    await send({ type: 'image', contentProvider: { type: 'line' } });
    await text('/fbphoto Sunset 🌅');
    assert.match(replies.at(-1), /Ready to post a photo[\s\S]*Sunset 🌅/);
    await text('/post');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, '/v23.0/61594634443175/photos');
    assert.ok(calls[1].body instanceof FormData);
    assert.equal(calls[1].body.get('caption'), 'Sunset 🌅');
    assert.equal(calls[1].body.get('source').type, 'image/jpeg');
    assert.match(replies.at(-1), /facebook.com\/61594634443175_999/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an expired or revoked token is explained and nothing is posted', async () => {
  const replies = [];
  client.replyMessage = async ({ messages }) => replies.push(messages[0].text);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 190, message: 'Session has expired' } }), { status: 400 });
  const text = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId: 'Uowner' }, message: { id: '1', type: 'text', text: t } });
  try {
    await text('/fb Test');
    await text('/post');
    assert.match(replies.at(-1), /rejected the Page access token[\s\S]*Nothing was posted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
