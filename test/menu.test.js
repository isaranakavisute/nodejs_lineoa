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
process.env.EMAIL_MY_ADDRESS = 'isara_nakavisute@hotmail.com';
process.env.EMAIL_MY_NAME = 'Isara Nakavisute';
process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
process.env.FACEBOOK_PAGE_ID = '111';
process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'page-token';
fs.writeFileSync(path.join(dataDir, 'microsoft-token.json'), JSON.stringify({ refreshToken: 'r', scope: 'offline_access Calendars.ReadWrite Mail.Send Mail.Read' }));

const { handleEvent } = await import('../src/handlers.js');
const { client, blobClient } = await import('../src/line.js');

// Captures every bot reply: its text and the labels of its buttons.
const replies = [];
// Flex cards in a reply: each card's texts and button actions.
const collect = (node, type, out = []) => {
  if (node && typeof node === 'object') {
    if (node.type === type) out.push(node);
    Object.values(node).forEach((v) => collect(v, type, out));
  }
  return out;
};
const cardsOf = (messages) => messages.filter((m) => m.type === 'flex').flatMap((m) => (m.contents.type === 'carousel' ? m.contents.contents : [m.contents]))
  .map((bubble) => ({ text: collect(bubble, 'text').map((t) => t.text).join('\n'), buttons: collect(bubble, 'button').map((b) => b.action) }));
client.replyMessage = async ({ messages }) => {
  replies.push({
    text: messages.map((m) => m.text).filter(Boolean).join('\n\n'),
    buttons: (messages.at(-1).quickReply?.items ?? []).map((i) => i.action),
    cards: cardsOf(messages),
    messages,
  });
};
// Taps a button inside email card `n` (1-based) of the last reply.
const tapCard = (n, label) => {
  const action = last().cards[n - 1]?.buttons.find((b) => b.label === label);
  assert.ok(action, `button "${label}" should be on card ${n}`);
  return tap(action.data);
};
client.showLoadingAnimation = async () => ({});
blobClient.getMessageContent = async () => Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])]);

// Two unread emails in the Inbox (none in Junk).
// Fixed times (m1 newest) so the email numbers never swap between runs.
const received = { m1: -60000, m2: -120000, m3: -30000 };
const mail = (id, subject, name, address) => {
  const time = new Date(Date.now() + (received[id] ?? -180000)).toISOString();
  return {
    id, subject, from: { emailAddress: { name, address } }, toRecipients: [{ emailAddress: { address: 'isara_nakavisute@hotmail.com' } }],
    ccRecipients: [], sentDateTime: time, receivedDateTime: time, body: { content: 'Hello' },
  };
};
const INBOX = [mail('m1', 'Project kickoff', 'Somchai Jaidee', 'somchai@example.com'), mail('m2', 'Invoice', '', 'billing@example.com')];
// Project kickoff also went to two colleagues; Invoice went only to me.
INBOX[0].toRecipients.push({ emailAddress: { name: 'Ann', address: 'ann@example.com' } });
INBOX[0].ccRecipients.push({ emailAddress: { name: 'Bee', address: 'bee@example.com' } });

// Fake Microsoft and Facebook APIs; records every write.
const writes = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === 'login.microsoftonline.com') return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
  if (init.method && init.method !== 'GET') writes.push({ host: u.hostname, path: u.pathname, body: init.body });
  if (u.pathname === '/v1.0/me/events') return new Response(JSON.stringify({ id: 'evt1' }));
  if (u.pathname === '/v1.0/me/sendMail') return new Response(null, { status: 202 });
  if (/^\/v1\.0\/me\/messages\/[^/]+\/(reply|replyAll|forward)$/.test(u.pathname)) return new Response(null, { status: 202 });
  if (u.pathname === '/v1.0/me/mailFolders/inbox/messages') return new Response(JSON.stringify({ value: INBOX }));
  if (u.pathname.startsWith('/v1.0/me/messages/')) {
    return new Response(JSON.stringify({ ...INBOX[0], body: { contentType: 'text', content: 'Can you join on Friday?' } }));
  }
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
// Taps ✅ Send on an email preview, checks the "are you sure?" prompt (nothing sent yet), then confirms.
async function confirmAndSend(question) {
  const count = writes.length;
  await tapButton('✅ Send');
  assert.match(last().text, /⚠️ Please confirm/);
  assert.match(last().text, question);
  assert.equal(writes.length, count, 'nothing sent before ✅ Yes, send now');
  await tapButton('✅ Yes, send now');
}

test('/menu and menu tiles show buttons; other users get nothing private', async () => {
  await text('/menu');
  assert.deepEqual(last().buttons.map((b) => b.label), ['📬 Inbox', '✉️ Email', '📅 Calendar', '📘 Facebook', '💬 Chat / Translate', '❓ Help']);
  await tap('menu=calendar');
  assert.deepEqual(last().buttons.map((b) => b.label), ['📋 Today', '🌅 Tomorrow', '🗓 Week', '➕ Add a meeting', '↩️ Undo last added', '❓ Calendar help']);

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

test('/inbox: pick an email, reply with a standard response, preview, then send', async () => {
  await text('/inbox');
  assert.match(last().text, /Unread emails today: 2/);
  // No buttons at the end of the chat; each email is a card with its own buttons.
  assert.equal(last().buttons.length, 0);
  assert.equal(last().cards.length, 2);
  assert.match(last().cards[0].text, /Email 1 of 2\nProject kickoff\nFrom: Somchai Jaidee <somchai@example.com>/);
  assert.match(last().cards[1].text, /Email 2 of 2\nInvoice/);
  for (const c of last().cards) assert.deepEqual(c.buttons.map((b) => b.label), ['↩️ Reply', '👥 Reply all', '➡️ Forward']);
  assert.equal(last().messages[1].contents.type, 'carousel');

  await tapCard(1, '↩️ Reply');
  assert.ok(last().buttons.some((b) => b.label === '✅ Well received'));
  const count = writes.length;
  await tapButton('✅ Well received');
  assert.match(last().text, /Ready to reply[\s\S]*RE: Project kickoff[\s\S]*Dear Somchai Jaidee,\n\nYour message is well received\. I will get back to you\.\n\nBest Regards,\nIsara Nakavisute/);
  assert.equal(writes.length, count, 'nothing sent before ✅ Send');

  await confirmAndSend(/Please confirm\n\nSend your reply to Somchai Jaidee <somchai@example.com>\?/);
  assert.match(last().text, /Replied: "Project kickoff"/);
  const sent = writes.at(-1);
  assert.equal(sent.path, '/v1.0/me/messages/m1/reply');
  const content = JSON.parse(sent.body).message.body;
  assert.equal(content.contentType, 'Text');
  assert.match(content.content, /^Dear Somchai Jaidee,[\s\S]*_{10,}\nFrom: Somchai Jaidee <somchai@example.com>[\s\S]*Can you join on Friday\?$/);
});

test('reply all greets "Dear all"; own text and Thai template work', async () => {
  await text('/inbox');
  await text('/replyall 1');
  await tapButton('🇹🇭 รับทราบ');
  assert.match(last().text, /เรียน ทุกท่าน\n\nได้รับอีเมลของท่านเรียบร้อยแล้ว[\s\S]*ขอแสดงความนับถือ\nIsara Nakavisute/);
  await tapButton('⬅️ Other responses');
  await tapButton('✍️ Write my own');
  await text('Hi team,\nSee you Friday.\nIsara');
  assert.match(last().text, /Ready to reply to all[\s\S]*Hi team,\nSee you Friday\.\nIsara/);
  await confirmAndSend(/Reply to all: send your reply to Somchai Jaidee <somchai@example.com> and 2 other people\?/);
  assert.equal(writes.at(-1).path, '/v1.0/me/messages/m1/replyAll');
  assert.match(JSON.parse(writes.at(-1).body).message.body.content, /^Hi team,\nSee you Friday\.\nIsara/);

  // Reply all to an email sent only to me: it reaches just the sender, so greet them, not "all".
  await text('/replyall 2');
  assert.match(last().text, /no one else was on this email/);
  await tapButton('✅ Well received');
  assert.match(last().text, /Dear Sir\/Madam,/);
  assert.doesNotMatch(last().text, /Dear all|everyone in To\/Cc/);
  await tapButton('❌ Cancel');

  // No display name: a polite generic greeting.
  await text('/reply 2');
  await tapButton('👍 Confirmed');
  assert.match(last().text, /Dear Sir\/Madam,/);
  await tapButton('❌ Cancel');
});

test('forward asks for the address, offers notes, and sends to that address', async () => {
  await text('/inbox');
  await text('/forward 1');
  assert.match(last().text, /Who should I forward it to/);
  await text('nope');
  assert.match(last().text, /isn't an email address/);
  await text('boss@example.com');
  await tapButton('ℹ️ FYI');
  assert.match(last().text, /Ready to forward[\s\S]*To: boss@example.com[\s\S]*FW: Project kickoff[\s\S]*FYI\./);
  await confirmAndSend(/Forward \"Project kickoff\" to boss@example.com\?/);
  assert.match(last().text, /Forwarded "Project kickoff" to boss@example.com/);
  const sent = JSON.parse(writes.at(-1).body);
  assert.equal(writes.at(-1).path, '/v1.0/me/messages/m1/forward');
  assert.deepEqual(sent.message.toRecipients, [{ emailAddress: { address: 'boss@example.com' } }]);
});

test('an email number that was not listed is explained', async () => {
  await text('/inbox');
  await text('/reply 9');
  assert.match(last().text, /can't find email 9/);
});

test('otherRecipients counts people besides me and the sender', async () => {
  const { otherRecipients } = await import('../src/mailActions.js');
  const from = 'A <a@x.com>';
  assert.equal(otherRecipients({ from, to: ['isara_nakavisute@hotmail.com'], cc: [] }), 0);
  assert.equal(otherRecipients({ from, to: ['isara_nakavisute@hotmail.com', from], cc: [] }), 0, 'sender copying themselves');
  assert.equal(otherRecipients({ from, to: ['isara_nakavisute@hotmail.com', 'B <b@x.com>'], cc: ['C <c@x.com>'] }), 2);
  // The case from a real reply: sender Cc'd themselves without their display name (and in other letter case).
  assert.equal(otherRecipients({ from: 'Isara Nakavisute <isara.nakavisute@gmail.com>', to: ['isara_nakavisute@hotmail.com'], cc: ['Isara.Nakavisute@gmail.com'] }), 0);
  // The same colleague in both To and Cc counts once.
  assert.equal(otherRecipients({ from, to: ['isara_nakavisute@hotmail.com', 'Bee <b@x.com>'], cc: ['b@x.com'] }), 1);
});

test('the confirmation can go back to the preview or cancel, and nothing is sent', async () => {
  await text('/inbox');
  await text('/reply 1');
  await tapButton('🙏 Thank you');
  const count = writes.length;
  await tapButton('✅ Send');
  await tapButton('⬅️ Back to preview');
  assert.match(last().text, /Ready to reply/);
  await text('Changed my mind, new text.');
  await tapButton('✅ Send');
  assert.match(last().text, /Please confirm/);
  await tapButton('❌ No, cancel');
  assert.match(last().text, /Cancelled\. Nothing was sent/);
  assert.equal(writes.length, count);
  // A stale "Yes" tap after cancelling does nothing.
  await tap('wiz=sendnow');
  assert.match(last().text, /expired\. Nothing was sent/);
  assert.equal(writes.length, count);
});

test('reply all to an email where the sender only Cc\'d themselves greets the sender by name', async () => {
  INBOX.push({
    ...mail('m3', 'Test', 'Isara Nakavisute', 'isara.nakavisute@gmail.com'),
    toRecipients: [{ emailAddress: { name: 'isara_nakavisute@hotmail.com', address: 'isara_nakavisute@hotmail.com' } }],
    ccRecipients: [{ emailAddress: { name: 'isara.nakavisute@gmail.com', address: 'isara.nakavisute@gmail.com' } }],
  });
  await text('/inbox');
  await text('/replyall 1');
  assert.match(last().text, /no one else was on this email/);
  await tapButton('✅ Well received');
  assert.match(last().text, /Dear Isara Nakavisute,\n\nYour message is well received/);
  assert.doesNotMatch(last().text, /Dear all/);
  await tapButton('❌ Cancel');
  INBOX.pop();
});

test('replies and forwards always copy me, and reply all keeps everyone else', async () => {
  const { replyRecipients } = await import('../src/mailActions.js');
  const r = (address, name) => ({ emailAddress: name ? { name, address } : { address } });
  const me = r('isara_nakavisute@hotmail.com', 'Isara Nakavisute');
  const original = {
    from: r('somchai@example.com', 'Somchai'),
    toRecipients: [r('Isara_Nakavisute@hotmail.com', 'Isara'), r('ann@example.com', 'Ann')],
    ccRecipients: [r('bee@example.com'), r('ann@example.com')],
  };
  // Reply: only the sender, me in Cc.
  assert.deepEqual(replyRecipients(original, { all: false }), { toRecipients: [r('somchai@example.com', 'Somchai')], ccRecipients: [me] });
  // Reply all: sender + other To people; the original Cc (Ann only once); me in Cc; me never in To.
  assert.deepEqual(replyRecipients(original, { all: true }), {
    toRecipients: [r('somchai@example.com', 'Somchai'), r('ann@example.com', 'Ann')],
    ccRecipients: [r('bee@example.com'), me],
  });
  // Reply-To is respected.
  assert.deepEqual(replyRecipients({ ...original, replyTo: [r('team@example.com')] }, { all: false }).toRecipients, [r('team@example.com')]);
  // My own email (sender is me): I'm the recipient, not also copied.
  assert.deepEqual(replyRecipients({ from: me, toRecipients: [me], ccRecipients: [] }, { all: true }), { toRecipients: [me], ccRecipients: [] });
});

test('sent reply, reply all and forward carry the right To and Cc', async () => {
  const sentTo = () => {
    const { message } = JSON.parse(writes.at(-1).body);
    return { to: (message.toRecipients ?? []).map((x) => x.emailAddress.address), cc: (message.ccRecipients ?? []).map((x) => x.emailAddress.address) };
  };
  await text('/inbox');
  await text('/reply 1');
  await tapButton('🙏 Thank you');
  assert.match(last().text, /Cc: Isara Nakavisute <isara_nakavisute@hotmail\.com>/);
  await tapButton('✅ Send');
  assert.match(last().text, /A copy goes to Isara Nakavisute <isara_nakavisute@hotmail\.com>/);
  await tapButton('✅ Yes, send now');
  assert.deepEqual(sentTo(), { to: ['somchai@example.com'], cc: ['isara_nakavisute@hotmail.com'] });

  await text('/replyall 1');
  await tapButton('🙏 Thank you');
  await tapButton('✅ Send');
  await tapButton('✅ Yes, send now');
  assert.deepEqual(sentTo(), { to: ['somchai@example.com', 'ann@example.com'], cc: ['bee@example.com', 'isara_nakavisute@hotmail.com'] });

  await text('/forward 1');
  await text('boss@example.com');
  await tapButton('ℹ️ FYI');
  assert.match(last().text, /To: boss@example\.com\nCc: Isara Nakavisute <isara_nakavisute@hotmail\.com>/);
  await tapButton('✅ Send');
  await tapButton('✅ Yes, send now');
  assert.deepEqual(sentTo(), { to: ['boss@example.com'], cc: ['isara_nakavisute@hotmail.com'] });
  assert.deepEqual(JSON.parse(writes.at(-1).body).message.ccRecipients, [{ emailAddress: { name: 'Isara Nakavisute', address: 'isara_nakavisute@hotmail.com' } }]);
});

test('each card\'s buttons act on that card\'s email', async () => {
  await text('/inbox');
  await tapCard(2, '👥 Reply all');
  assert.match(last().text, /Reply all to:\nInvoice/);
  await tapButton('❌ Cancel');
  await text('/inbox');
  await tapCard(1, '➡️ Forward');
  assert.match(last().text, /Forward:\nProject kickoff/);
  await tapButton('❌ Cancel');
});
