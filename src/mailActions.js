// Reply, reply-all and forward for emails listed by /inbox, with ready-made standard responses.
// Uses Microsoft Graph's reply/replyAll/forward actions, which need only Mail.Send (no write access
// to the mailbox). No AI involved.
import { config } from './config.js';
import { graphGet, graphRequest } from './microsoft.js';
import { formatDateTime } from './calendar.js';

// Standard responses for Reply / Reply all. The greeting ("Dear …,") and sign-off are added around them.
export const REPLY_TEMPLATES = [
  { label: '✅ Well received', body: 'Your message is well received. I will get back to you.' },
  { label: '🙏 Thank you', body: 'Thank you for your email. I have noted the details.' },
  { label: '👍 Confirmed', body: 'Thank you. I confirm the above.' },
  { label: '🔍 Looking into it', body: 'Thank you for your email. I am looking into this and will update you shortly.' },
  { label: '❓ More details', body: 'Thank you for your email. Could you please send me more details so that I can look into this?' },
  { label: "📅 Let's meet", body: 'Thank you for your email. Could we arrange a short meeting to discuss this? Please let me know a time that suits you.' },
  { label: '🙅 Decline', body: 'Thank you for thinking of me. Unfortunately, I am unable to accept at this time.' },
  { label: '🇹🇭 รับทราบ', thai: true, body: 'ได้รับอีเมลของท่านเรียบร้อยแล้ว และจะติดต่อกลับโดยเร็วที่สุด' },
];

// Standard notes for Forward.
export const FORWARD_NOTES = [
  { label: 'ℹ️ FYI', body: 'FYI.' },
  { label: '👀 Please review', body: 'Please review the email below and let me know your thoughts.' },
  { label: '🛠 Please handle', body: 'Could you please handle this? Thank you.' },
];

const signOff = (thai) => `${thai ? 'ขอแสดงความนับถือ' : 'Best Regards,'}${config.email.signature ? `\n${config.email.signature}` : ''}`;

// A display name worth greeting: not empty and not just an email address.
const greetable = (name) => (name && !name.includes('@') ? name : '');

// How many people besides you and the sender were on the email (To and Cc), i.e. who else
// "Reply all" would reach. You are one of the To/Cc addresses, so one is not counted.
export function otherRecipients(email) {
  const everyone = new Set([...email.to, ...email.cc].filter((address) => address !== email.from));
  return Math.max(everyone.size - 1, 0);
}

// The full reply text for a standard response: greeting, response, sign-off.
// `all` is true only when the reply goes to several people ("Dear all"); otherwise the sender is greeted by name.
export function composeReply(template, { all, senderName }) {
  const name = greetable(senderName);
  const greeting = template.thai
    ? `เรียน ${all ? 'ทุกท่าน' : name ? `คุณ${name}` : 'ท่านผู้เกี่ยวข้อง'}`
    : `Dear ${all ? 'all' : name || 'Sir/Madam'},`;
  return `${greeting}\n\n${template.body}\n\n${signOff(template.thai)}`;
}

export function composeForwardNote(note) {
  return `${note.body}\n\n${signOff(false)}`;
}

const listAddresses = (recipients = []) =>
  recipients.map(({ emailAddress: a }) => (a?.name && a.name !== a.address ? `${a.name} <${a.address}>` : a?.address)).join('; ');

// The original email as plain text, quoted under the reply the way Outlook does.
async function quotedOriginal(id) {
  const m = await graphGet(`/me/messages/${encodeURIComponent(id)}?$select=from,toRecipients,ccRecipients,subject,sentDateTime,body`, {
    Prefer: 'outlook.body-content-type="text"',
  });
  const lines = ['________________________________', `From: ${listAddresses([m.from])}`, `Sent: ${formatDateTime(new Date(m.sentDateTime))}`];
  if (m.toRecipients?.length) lines.push(`To: ${listAddresses(m.toRecipients)}`);
  if (m.ccRecipients?.length) lines.push(`Cc: ${listAddresses(m.ccRecipients)}`);
  lines.push(`Subject: ${m.subject ?? ''}`, '', (m.body?.content ?? '').trim());
  return lines.join('\n');
}

// Sends the body as plain text (so line breaks are kept) with the original quoted underneath.
// Graph fills in the recipients, "RE:"/"FW:" subject and conversation threading.
async function send(id, action, text, extra = {}) {
  const content = `${text}\n\n${await quotedOriginal(id)}`;
  await graphRequest('POST', `/me/messages/${encodeURIComponent(id)}/${action}`, {
    body: { message: { ...extra, body: { contentType: 'Text', content } } },
  });
}

export function sendReply(id, text, { all = false } = {}) {
  return send(id, all ? 'replyAll' : 'reply', text);
}

export function sendForward(id, to, text) {
  return send(id, 'forward', text, { toRecipients: to.map((address) => ({ emailAddress: { address } })) });
}
