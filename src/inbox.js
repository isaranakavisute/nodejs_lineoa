// Lists today's unread emails from the owner's Outlook Inbox and Junk Email folders. No AI involved.
// Reading messages through Graph does not mark them as read.
import { config } from './config.js';
import { graphGet } from './microsoft.js';
import { startOfToday } from './calendar.js';

const PREVIEW_LINES = 5;
const MAX_LINE_LENGTH = 200;
// Stop after this many emails so the reply stays readable.
const MAX_EMAILS = 30;
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

// Unread emails from Inbox and Junk received since midnight today, newest first.
// Returns { emails, hasMore, counts: { Inbox, Junk } }.
export async function fetchUnreadToday(now) {
  const results = await Promise.all(FOLDERS.map((folder) => fetchUnreadInFolder(folder, now)));
  const all = results.flatMap((r) => r.emails).sort((a, b) => b.received - a.received);
  const counts = Object.fromEntries(FOLDERS.map((f, i) => [f.name, results[i].emails.length]));
  return {
    emails: all.slice(0, MAX_EMAILS),
    hasMore: all.length > MAX_EMAILS || results.some((r) => r.hasMore),
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

// Returns the reply as a list of LINE text messages.
export function formatInbox({ emails, hasMore, counts = {} }) {
  if (emails.length === 0) return ['📭 No unread emails today (Inbox and Junk).'];

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0) || emails.length;
  const count = hasMore ? `${total}+` : String(total);
  const breakdown = Object.keys(counts).length
    ? `\n(${Object.entries(counts).map(([folder, n]) => `${folder}: ${n}`).join(', ')})`
    : '';
  const blocks = [`📬 Unread emails today: ${count}${breakdown}`, ...emails.map(describe)];
  if (hasMore) blocks.push(`Showing the newest ${emails.length}. Open Outlook to see the rest.`);

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
