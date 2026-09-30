// Lists today's unread emails from the owner's Outlook Inbox and Junk Email folders. No AI involved.
// Reading messages through Graph does not mark them as read.
import { config } from './config.js';
import { graphGet } from './microsoft.js';
import { startOfToday } from './calendar.js';

const PREVIEW_LINES = 5;
const MAX_LINE_LENGTH = 200;
// Emails fetched per folder, so the unread count is right even though only a few are shown.
const MAX_EMAILS = 30;
// /inbox shows only the newest few unread emails.
const SHOW_EMAILS = 5;
// LINE: at most 5 messages per reply, 5,000 characters each.
const MAX_REPLY_MESSAGES = 5;
const LINE_TEXT_LIMIT = 5000;

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// Folders checked, by Microsoft Graph well-known folder name.
const FOLDERS = [
  { id: 'inbox', name: 'Inbox' },
  { id: 'junkemail', name: 'Junk' },
];

// Unread emails in one folder received since midnight today.
async function fetchUnreadInFolder(folder, now) {
  const query = new URLSearchParams({
    // Graph requires the $orderby property to come first in $filter.
    $filter: `receivedDateTime ge ${startOfToday(now).toISOString()} and isRead eq false`,
    $orderby: 'receivedDateTime desc',
    $select: 'from,toRecipients,ccRecipients,subject,sentDateTime,receivedDateTime,body',
    $top: String(MAX_EMAILS),
  });
  const result = await graphGet(`/me/mailFolders/${folder.id}/messages?${query}`, {
    // Ask for plain-text bodies instead of HTML.
    Prefer: 'outlook.body-content-type="text"',
  });

  return {
    hasMore: Boolean(result['@odata.nextLink']),
    emails: result.value.map((m) => ({
      id: m.id,
      folder: folder.name,
      fromName: m.from?.emailAddress?.name ?? '',
      from: formatAddress(m.from?.emailAddress),
      to: (m.toRecipients ?? []).map((r) => formatAddress(r.emailAddress)),
      cc: (m.ccRecipients ?? []).map((r) => formatAddress(r.emailAddress)),
      subject: m.subject || '(no subject)',
      sent: new Date(m.sentDateTime),
      received: new Date(m.receivedDateTime),
      preview: firstLines(m.body?.content ?? ''),
    })),
  };
}

// The newest unread emails (up to SHOW_EMAILS) from Inbox and Junk received since midnight today.
// Returns { emails, hasMore, counts: { Inbox, Junk } }; counts are for all unread emails fetched,
// and hasMore means a folder has more than MAX_EMAILS (so the count is "30+").
export async function fetchUnreadToday(now) {
  const results = await Promise.all(FOLDERS.map((folder) => fetchUnreadInFolder(folder, now)));
  const all = results.flatMap((r) => r.emails).sort((a, b) => b.received - a.received);
  const counts = Object.fromEntries(FOLDERS.map((f, i) => [f.name, results[i].emails.length]));
  return {
    emails: all.slice(0, SHOW_EMAILS),
    hasMore: results.some((r) => r.hasMore),
    counts,
  };
}

// The emails shown by the last /inbox, so "/reply 2" etc. know which email is meant.
let listed = [];

export function rememberListed(emails) {
  listed = emails;
}

// The nth email (1-based) from the last /inbox, or null.
export function listedEmail(n) {
  return listed[n - 1] ?? null;
}

function formatAddress(address) {
  if (!address) return '(unknown)';
  const { name, address: email } = address;
  return name && name !== email ? `${name} <${email}>` : email;
}

// Invisible characters newsletters use as padding (combining grapheme joiner, zero-width spaces, soft hyphen, BOM).
const INVISIBLE = /[͏­᠎​-‏⁠-⁤﻿]/g;
// Link targets that plain-text conversion appends after link text, e.g. "Manage your apps<https://...>".
const LINK_TARGET = /<(?:https?:|mailto:)[^>\s]*>/gi;
// Image or link addresses in square brackets, e.g. "[https://.../logo.png]".
const BRACKETED_URL = /\[(?:https?:|mailto:)[^\]\s]*\]/gi;
// Lines that are only a link address.
const BARE_URL_LINE = /^(?:https?:\/\/|mailto:)\S*$/i;

// The first few lines of readable text in a plain-text body, skipping blank lines,
// link/image addresses and invisible padding.
export function firstLines(text, count = PREVIEW_LINES) {
  return text
    .replace(INVISIBLE, '')
    .replace(LINK_TARGET, '')
    .replace(BRACKETED_URL, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line && !BARE_URL_LINE.test(line) && /[\p{L}\p{N}]/u.test(line))
    .slice(0, count)
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));
}

function formatSent(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.calendar.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function describe(email, index) {
  const number = NUMBER_EMOJI[index] ?? `${index + 1}.`;
  const lines = [
    `${number} ${email.folder === 'Junk' ? '⚠️ [Junk] ' : ''}${email.subject}`,
    `From: ${email.from}`,
    `To: ${email.to.join(', ') || '(none)'}`,
  ];
  if (email.cc.length) lines.push(`Cc: ${email.cc.join(', ')}`);
  lines.push(`Sent: ${formatSent(email.sent)}`);
  lines.push('──────────');
  lines.push(...(email.preview.length ? email.preview : ['(no text)']));
  return lines.join('\n');
}

const NO_EMAIL = '📭 No unread emails today (Inbox and Junk).';

const totalOf = ({ emails, counts = {} }) => Object.values(counts).reduce((sum, n) => sum + n, 0) || emails.length;

// "Showing the newest 5. Open Outlook to see the rest." when not every unread email is shown.
function showingNote(result) {
  return result.hasMore || result.emails.length < totalOf(result) ? `Showing the newest ${result.emails.length}. Open Outlook to see the rest.` : '';
}

// "📬 Unread emails today: 3\n(Inbox: 2, Junk: 1)"
function summary({ emails, hasMore, counts = {} }) {
  const total = totalOf({ emails, counts });
  const count = hasMore ? `${total}+` : String(total);
  const breakdown = Object.keys(counts).length
    ? `\n(${Object.entries(counts).map(([folder, n]) => `${folder}: ${n}`).join(', ')})`
    : '';
  return `📬 Unread emails today: ${count}${breakdown}`;
}

// Returns the reply as a list of LINE text messages.
export function formatInbox({ emails, hasMore, counts = {} }) {
  if (emails.length === 0) return [NO_EMAIL];

  const blocks = [summary({ emails, hasMore, counts }), ...emails.map(describe)];
  const note = showingNote({ emails, hasMore, counts });
  if (note) blocks.push(note);

  // Pack blocks into as few messages as possible.
  const messages = [];
  for (const block of blocks) {
    const last = messages.at(-1);
    if (last !== undefined && last.length + block.length + 2 <= LINE_TEXT_LIMIT) {
      messages[messages.length - 1] = `${last}\n\n${block}`;
    } else {
      messages.push(block.slice(0, LINE_TEXT_LIMIT));
    }
  }

  if (messages.length > MAX_REPLY_MESSAGES) {
    const kept = messages.slice(0, MAX_REPLY_MESSAGES);
    kept[MAX_REPLY_MESSAGES - 1] = `${kept[MAX_REPLY_MESSAGES - 1].slice(0, LINE_TEXT_LIMIT - 60)}\n\n…too many to show here. Open Outlook to see the rest.`;
    return kept;
  }
  return messages;
}

// ---- Cards: one per email, with its own Reply / Reply all / Forward buttons ----

// LINE: a carousel holds at most 12 cards and 50 KB; a reply holds at most 5 messages.
const CARDS_PER_CAROUSEL = 12;
const CAROUSEL_MAX_BYTES = 45000;

// A button that runs a bot command when tapped (handled like the menu's buttons).
const commandButton = (label, cmd, style) => ({
  type: 'button', style, height: 'sm',
  action: { type: 'postback', label, data: new URLSearchParams({ cmd }).toString(), displayText: label },
});

const line = (text, extra = {}) => ({ type: 'text', text, size: 'xs', color: '#555555', wrap: true, ...extra });

function card(email, index, total) {
  const n = index + 1;
  const details = [
    line(`From: ${email.from}`),
    line(`To: ${email.to.join(', ') || '(none)'}`),
    ...(email.cc.length ? [line(`Cc: ${email.cc.join(', ')}`)] : []),
    line(`Sent: ${formatSent(email.sent)}`),
  ];
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        line(`${NUMBER_EMOJI[index] ?? `${n}.`} Email ${n} of ${total}${email.folder === 'Junk' ? ' · ⚠️ Junk' : ''}`, { color: email.folder === 'Junk' ? '#D93025' : '#888888' }),
        { type: 'text', text: email.subject, weight: 'bold', size: 'md', wrap: true },
        { type: 'box', layout: 'vertical', spacing: 'xs', contents: details },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: email.preview.length ? email.preview.join('\n') : '(no text)', size: 'sm', wrap: true, margin: 'md', maxLines: 12 },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        commandButton('↩️ Reply', `/reply ${n}`, 'primary'),
        {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [commandButton('👥 Reply all', `/replyall ${n}`, 'secondary'), commandButton('➡️ Forward', `/forward ${n}`, 'secondary')],
        },
      ],
    },
  };
}

// The /inbox reply as LINE messages: a summary, then the emails as swipeable cards.
export function inboxMessages({ emails, hasMore, counts = {} }) {
  if (emails.length === 0) return [{ type: 'text', text: NO_EMAIL }];

  let head = summary({ emails, hasMore, counts });
  if (emails.length > 1) head += '\n\nSwipe the cards ⬅️ ➡️ — each has its own Reply / Reply all / Forward buttons.';
  const note = showingNote({ emails, hasMore, counts });
  if (note) head += `\n\n${note}`;

  // Group cards into carousels within LINE's limits.
  const carousels = [];
  let current = [];
  for (const [i, email] of emails.entries()) {
    const bubble = card(email, i, emails.length);
    const tooBig = JSON.stringify([...current, bubble]).length > CAROUSEL_MAX_BYTES;
    if (current.length && (current.length === CARDS_PER_CAROUSEL || tooBig)) {
      carousels.push(current);
      current = [];
    }
    current.push(bubble);
  }
  carousels.push(current);

  // The summary takes one of the 5 messages; any cards beyond that are left out (with a note).
  const shown = carousels.slice(0, MAX_REPLY_MESSAGES - 1);
  if (shown.length < carousels.length) head += '\n\n…too many to show here. Open Outlook to see the rest.';
  const messages = [{ type: 'text', text: head }];
  for (const bubbles of shown) {
    messages.push({
      type: 'flex',
      altText: `📬 ${emails.length} unread email${emails.length === 1 ? '' : 's'} — open LINE on your phone to see them.`,
      contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
    });
  }
  return messages;
}
