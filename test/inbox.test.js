import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineoa-inbox-'));
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DATA_DIR = dataDir;
process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.CALENDAR_ALERT_TO = 'Uowner';
process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';

const { firstLines, formatInbox, fetchUnreadToday, inboxMessages } = await import('../src/inbox.js');

test('keeps the first 5 non-empty lines', () => {
  assert.deepEqual(firstLines('Hi Isara,\r\n\r\n  line 2 \n\nline 3\nline 4\nline 5\nline 6'), ['Hi Isara,', 'line 2', 'line 3', 'line 4', 'line 5']);
});

test('skips link addresses, image lines and invisible padding in newsletters', () => {
  const body = [
    'Check out today\'s top price drops!',
    '͏ ͏ ͏ ͏ ​​ ͏ ͏',
    '[https://image.example.com/logo.png]',
    'Hotels & Homes<https://tracking.example.com/click?x=1>',
    '________________________________',
    '<https://tracking.example.com/only-a-link>',
    'Manage your apps<https://account.example.com/manage>',
    'Contact us<mailto:help@example.com> anytime',
    '[https://image.example.com/badge.png] Member 12345',
    'Line six',
  ].join('\n');
  assert.deepEqual(firstLines(body), [
    'Check out today\'s top price drops!',
    'Hotels & Homes',
    'Manage your apps',
    'Contact us anytime',
    'Member 12345',
  ]);
});

test('summarises count, sender, subject, time, recipients and preview', () => {
  const [text] = formatInbox({
    hasMore: false,
    emails: [{
      from: 'Shopee <no-reply@shopee.co.th>', to: ['me@hotmail.com'], cc: ['boss@example.com'],
      subject: 'Your order has shipped', sent: new Date('2026-09-28T07:05:00Z'), preview: ['Hello', 'Parcel #123'],
    }],
  });
  assert.match(text, /Unread emails today: 1/);
  assert.match(text, /1️⃣ Your order has shipped/);
  assert.match(text, /From: Shopee <no-reply@shopee.co.th>/);
  assert.match(text, /To: me@hotmail.com/);
  assert.match(text, /Cc: boss@example.com/);
  assert.match(text, /Sent: Mon 28 Sept, 14:05/);
  assert.match(text, /Hello\nParcel #123/);
});

test('no unread mail', () => {
  assert.deepEqual(formatInbox({ emails: [], hasMore: false }), ['📭 No unread emails today (Inbox and Junk).']);
});

test('long results are split to fit LINE limits (max 5 messages, 5,000 chars each)', () => {
  const email = { from: 'a@b.c', to: ['me@x.y'], cc: [], subject: 'S', sent: new Date(), preview: Array(5).fill('x'.repeat(200)) };
  const texts = formatInbox({ emails: Array(30).fill(email), hasMore: true });
  assert.ok(texts.length <= 5);
  assert.ok(texts.every((t) => t.length <= 5000));
  assert.match(texts[0], /Unread emails today: 30\+/);
});

test('checks Inbox and Junk for unread mail since midnight Bangkok time, read-only', async () => {
  fs.writeFileSync(path.join(dataDir, 'microsoft-token.json'), JSON.stringify({ refreshToken: 'r', scope: 'offline_access Mail.Read' }));
  const graphRequests = [];
  const message = (subject, received) => ({
    from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
    toRecipients: [{ emailAddress: { name: 'me@hotmail.com', address: 'me@hotmail.com' } }],
    subject, sentDateTime: received, receivedDateTime: received, body: { content: 'One\nTwo' },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
    const u = new URL(url);
    graphRequests.push({ path: u.pathname, filter: u.searchParams.get('$filter'), method: init.method, prefer: init.headers.Prefer });
    const value = u.pathname.includes('/junkemail/')
      ? [message('Win a prize', '2026-09-28T04:00:00Z')]
      : [message('Newest', '2026-09-28T04:30:00Z'), message('Oldest', '2026-09-28T03:00:00Z')];
    return new Response(JSON.stringify({ value }));
  };
  try {
    const result = await fetchUnreadToday(new Date('2026-09-28T05:00:00Z'));
    assert.deepEqual(graphRequests.map((r) => r.path).sort(), ['/v1.0/me/mailFolders/inbox/messages', '/v1.0/me/mailFolders/junkemail/messages']);
    for (const r of graphRequests) {
      assert.equal(r.filter, 'receivedDateTime ge 2026-09-27T17:00:00.000Z and isRead eq false');
      assert.equal(r.prefer, 'outlook.body-content-type="text"');
    }
    // Emails must stay unread: checking may only ever read (GET), never change a message.
    assert.deepEqual(graphRequests.map((r) => r.method), ['GET', 'GET']);

    assert.deepEqual(result.emails.map((e) => `${e.folder}:${e.subject}`), ['Inbox:Newest', 'Junk:Win a prize', 'Inbox:Oldest']);
    assert.deepEqual(result.counts, { Inbox: 2, Junk: 1 });
    assert.equal(result.emails[0].from, 'Bob <bob@example.com>');
    assert.deepEqual(result.emails[0].preview, ['One', 'Two']);

    const [text] = formatInbox(result);
    assert.match(text, /Unread emails today: 3\n\(Inbox: 2, Junk: 1\)/);
    assert.match(text, /2️⃣ ⚠️ \[Junk\] Win a prize/);
    assert.match(text, /1️⃣ Newest/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('inbox cards: one per email, within LINE limits (12 per carousel, 5 messages, 50 KB)', () => {
  const email = { folder: 'Inbox', from: 'A <a@x.com>', to: ['me@x.com'], cc: [], subject: 'Hello', sent: new Date(), received: new Date(), preview: Array(5).fill('x'.repeat(200)) };
  assert.deepEqual(inboxMessages({ emails: [], hasMore: false }), [{ type: 'text', text: '📭 No unread emails today (Inbox and Junk).' }]);

  const one = inboxMessages({ emails: [email], hasMore: false });
  assert.equal(one.length, 2);
  assert.equal(one[1].contents.type, 'bubble');

  const many = inboxMessages({ emails: Array(30).fill(email), hasMore: true });
  assert.ok(many.length <= 5);
  const flex = many.slice(1);
  const cards = flex.flatMap((m) => m.contents.contents);
  assert.equal(cards.length, 30);
  for (const m of flex) {
    assert.ok(m.contents.contents.length <= 12);
    assert.ok(JSON.stringify(m.contents).length < 50000);
    assert.ok(m.altText.length <= 400);
  }
  assert.match(many[0].text, /Showing the newest 30/);
});

test('/inbox shows only the newest 5, but counts every unread email', async () => {
  const at = (i) => new Date(Date.UTC(2026, 8, 28, 2, i)).toISOString();
  const msg = (i) => ({ id: `m${i}`, subject: `Email ${i}`, from: { emailAddress: { address: 'a@x.com' } }, toRecipients: [], ccRecipients: [], sentDateTime: at(i), receivedDateTime: at(i), body: { content: 'hi' } });
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'login.microsoftonline.com') return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
    const value = u.pathname.includes('/inbox/') ? Array.from({ length: 8 }, (_, i) => msg(i)) : [msg(20), msg(21)];
    return new Response(JSON.stringify({ value }));
  };
  try {
    const result = await fetchUnreadToday(new Date('2026-09-28T05:00:00Z'));
    assert.deepEqual(result.emails.map((e) => e.subject), ['Email 21', 'Email 20', 'Email 7', 'Email 6', 'Email 5']);
    assert.deepEqual(result.counts, { Inbox: 8, Junk: 2 });
    const [head, cards] = inboxMessages(result);
    assert.match(head.text, /Unread emails today: 10\n\(Inbox: 8, Junk: 2\)[\s\S]*Showing the newest 5\. Open Outlook to see the rest\./);
    assert.equal(cards.contents.contents.length, 5);
  } finally {
    globalThis.fetch = saved;
  }
});
