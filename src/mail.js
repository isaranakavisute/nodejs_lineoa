// Sends email from the owner's Outlook.com / Hotmail account. No AI involved.
import { graphRequest } from './microsoft.js';

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_RECIPIENTS = 10;

// Parses "/email" arguments:
//   line 1: recipient(s), separated by commas or spaces
//   line 2: subject
//   line 3+: message body
// Returns { to, subject, body } or { error, detail }.
export function parseEmailCommand(arg) {
  const [firstLine = '', subjectLine = '', ...bodyLines] = arg.split(/\r?\n/);
  const to = firstLine.split(/[\s,;]+/).filter(Boolean);
  const subject = subjectLine.replace(/^subject:\s*/i, '').trim();
  const body = bodyLines.join('\n').trim();

  if (to.length === 0) return { error: 'format' };
  const invalid = to.filter((address) => !EMAIL_PATTERN.test(address));
  if (invalid.length) return { error: 'address', detail: invalid.join(', ') };
  if (to.length > MAX_RECIPIENTS) return { error: 'too-many' };
  if (!subject || !body) return { error: 'format' };

  return { to: [...new Set(to)], subject: subject.slice(0, 255), body };
}

export async function sendEmail({ to, subject, body }) {
  await graphRequest('POST', '/me/sendMail', {
    body: {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    },
  });
}
