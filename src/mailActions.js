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

// The bare, lower-case email address from "Name <address>" or "address".
const bareAddress = (text) => (text.match(/<([^>]+)>\s*$/)?.[1] ?? text).trim().toLowerCase();

// Your own address (EMAIL_MY_ADDRESS), lower case; '' if not set.
const myAddress = () => config.email.myAddress.trim().toLowerCase();

// You as a recipient: "Isara Nakavisute <isara_nakavisute@hotmail.com>" (EMAIL_MY_NAME, EMAIL_MY_ADDRESS).
function myself() {
  const name = config.email.myName.trim();
  return { emailAddress: { ...(name ? { name } : {}), address: config.email.myAddress.trim() } };
}

// How many unique people besides you and the sender were on the email (To and Cc), i.e. who else
// "Reply all" would reach. People are compared by email address only, so "Isara <a@x.com>" and
// "A@x.com" are the same person. Without EMAIL_MY_ADDRESS, one To/Cc address is assumed to be you.
export function otherRecipients(email) {
  const sender = bareAddress(email.from);
  const me = myAddress();
  const everyone = new Set([...email.to, ...email.cc].map(bareAddress).filter((address) => address !== sender && address !== me));
  return me ? everyone.size : Math.max(everyone.size - 1, 0);
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

function fetchOriginal(id) {
  return graphGet(`/me/messages/${encodeURIComponent(id)}?$select=from,replyTo,toRecipients,ccRecipients,subject,sentDateTime,body`, {
    Prefer: 'outlook.body-content-type="text"',
  });
}

// The original email as plain text, quoted under the reply the way Outlook does.
function quote(m) {
  const lines = ['________________________________', `From: ${listAddresses([m.from])}`, `Sent: ${formatDateTime(new Date(m.sentDateTime))}`];
  if (m.toRecipients?.length) lines.push(`To: ${listAddresses(m.toRecipients)}`);
  if (m.ccRecipients?.length) lines.push(`Cc: ${listAddresses(m.ccRecipients)}`);
  lines.push(`Subject: ${m.subject ?? ''}`, '', (m.body?.content ?? '').trim());
  return lines.join('\n');
}

// Recipients with each address once (compared in lower case), leaving out `exclude`.
function uniqueRecipients(recipients, exclude = []) {
  const seen = new Set(exclude.map((a) => a.toLowerCase()));
  const result = [];
  for (const r of recipients) {
    const address = r?.emailAddress?.address?.toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    result.push({ emailAddress: { address: r.emailAddress.address, ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}) } });
  }
  return result;
}

const addressesOf = (recipients) => recipients.map((r) => r.emailAddress.address);

// To and Cc for a reply, with you (EMAIL_MY_ADDRESS) always in Cc.
// Reply: To = the sender (or their Reply-To). Reply all: To = the sender + the original To, Cc = the
// original Cc, leaving you out of both before adding you to Cc. The lists are built here, not left to
// Graph, because setting Cc on a reply-all could replace the Cc people Graph would otherwise add.
export function replyRecipients(original, { all }) {
  const me = myAddress();
  const sender = original.replyTo?.length ? original.replyTo : [original.from];
  if (!me) return {}; // let Graph choose the recipients as Outlook would
  let to = uniqueRecipients(all ? [...sender, ...(original.toRecipients ?? [])] : sender, [me]);
  // Replying to your own email: keep yourself as the only recipient rather than none.
  if (to.length === 0) to = [myself()];
  const cc = all ? uniqueRecipients(original.ccRecipients ?? [], [me, ...addressesOf(to)]) : [];
  const copyMe = addressesOf(to).some((a) => a.toLowerCase() === me) ? [] : [myself()];
  return { toRecipients: to, ccRecipients: [...cc, ...copyMe] };
}

// Sends the body as plain text (so line breaks are kept) with the original quoted underneath.
// Graph fills in the "RE:"/"FW:" subject and conversation threading.
async function send(id, action, text, recipientsFor) {
  const original = await fetchOriginal(id);
  const content = `${text}\n\n${quote(original)}`;
  await graphRequest('POST', `/me/messages/${encodeURIComponent(id)}/${action}`, {
    body: { message: { ...recipientsFor(original), body: { contentType: 'Text', content } } },
  });
}

export function sendReply(id, text, { all = false } = {}) {
  return send(id, all ? 'replyAll' : 'reply', text, (original) => replyRecipients(original, { all }));
}

// Forward to `to`, with you (EMAIL_MY_ADDRESS) in Cc unless you are already a recipient.
export function sendForward(id, to, text) {
  const me = myAddress();
  const toRecipients = to.map((address) => ({ emailAddress: { address } }));
  const copyMe = me && !to.some((a) => a.toLowerCase() === me) ? [myself()] : [];
  return send(id, 'forward', text, () => ({ toRecipients, ...(copyMe.length ? { ccRecipients: copyMe } : {}) }));
}

// For previews: "Isara Nakavisute <isara_nakavisute@hotmail.com>" when you are copied, else ''.
export function copyToMeLabel() {
  if (!myAddress()) return '';
  const { name, address } = myself().emailAddress;
  return name ? `${name} <${address}>` : address;
}
