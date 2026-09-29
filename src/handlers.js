import Anthropic from '@anthropic-ai/sdk';
import { client } from './line.js';
import { config } from './config.js';
import { translate, TranslationRefused } from './translate.js';
import { chat, ChatRefused } from './chat.js';
import { downloadImage, askAboutImage, ImageTooLarge, UnsupportedImage, AnswerRefused } from './vision.js';
import { getDigest, DigestRefused } from './news.js';
import { subscribe, unsubscribe, getSubscription } from './store.js';
import { fetchEvents, formatAgenda, endOfToday, parseMeetCommand, createEvent, deleteEvent, formatDateTime } from './calendar.js';
import { NotSignedIn, NoWriteAccess, hasPermission, isSignedIn } from './microsoft.js';
import { parseEmailCommand, sendEmail } from './mail.js';
import { fetchUnreadToday, formatInbox } from './inbox.js';
import { parseFacebookPost, postText, postPhoto, isFacebookConfigured, FacebookNotConfigured, FacebookTokenInvalid } from './facebook.js';

// A Facebook post waiting for the owner to confirm with /post: { message, link?, image?, expiresAt }.
let pendingFacebookPost = null;
const FACEBOOK_CONFIRM_MS = 10 * 60 * 1000;

const FACEBOOK_HELP = `📘 Facebook Page commands

📝 TEXT POST
/fb Your post text (can be several lines)
• A web address in the text is shown as a link preview

📷 PHOTO POST
1. Send me a photo
2. /fbphoto Your caption (caption is optional)

✅ CONFIRM
I reply with a preview first. Then:
/post – publish it to your Page
/cancel – discard it
• A draft expires after 10 minutes
• Published posts are public; delete them on Facebook if needed

Posts go to your Facebook Page (Facebook doesn't allow apps to post to personal profiles).

❓ /fbhelp – show this guide`;

// Meetings the owner created with /meet, newest last, so /meet undo can delete them.
const createdMeetings = [];

// An email waiting for the owner to confirm with /send: { to, subject, body, expiresAt }.
let pendingEmail = null;
const EMAIL_CONFIRM_MS = 10 * 60 * 1000;

const EMAIL_HELP = `✉️ Send an email from your Outlook account.
Write it as three parts on separate lines:

/email friend@example.com
Subject line
Message text (can be several lines)

Several recipients: separate them with commas.
I'll show a preview first; nothing is sent until you reply /send.

/emailhelp – all email commands`;

// Full guide to every email command, shown by /emailhelp (or /mailhelp).
const EMAIL_COMMANDS_HELP = `📧 Email commands

📬 CHECK EMAIL
/inbox  (or /mail)
Shows today's unread emails from your Inbox and Junk folders:
• how many unread emails arrived today
• for each one: subject, sender, recipients (To/Cc), time sent, and the first 5 lines
• junk is marked ⚠️ [Junk]
Checking never marks emails as read.

✉️ SEND EMAIL
Write three lines in one message:
/email friend@example.com
Subject line
Message text (can be several lines)

• Several recipients: separate with commas (up to 10)
• I reply with a preview first. Then:
/send – send it
/cancel – discard it
• A draft expires after 10 minutes
• Sent emails are saved in your Sent folder

Example:
/email friend@example.com
Lunch tomorrow
Are you free at 12:00?

❓ /emailhelp – show this guide`;

const MEET_HELP = `📅 Add a meeting to your Outlook calendar:
/meet in 30 Test – starts in 30 minutes
/meet 14:30 Standup – today (or tomorrow if 14:30 has passed)
/meet tomorrow 9:00 Review
/meet 2026-10-01 10:00 Planning
Add a length after the time, e.g. /meet 14:30 1h Workshop (default 30m).
/meet undo – delete the last meeting added here

/calendarhelp – all calendar commands`;

// Full guide to every calendar command, shown by /calendarhelp (or /calhelp).
const CALENDAR_COMMANDS_HELP = `📅 Calendar commands (Hotmail / Outlook)

⏰ AUTOMATIC ALERTS
I message you ${config.calendar.leadMinutes} minutes before each meeting in your Outlook calendar.
• Declined, cancelled and all-day events are skipped
• Meetings starting close together come in one message
• Each alert uses 1 message from your LINE monthly quota

📋 TODAY'S MEETINGS
/calendar
Shows the rest of today's meetings: title, time, place and online meeting link.

➕ ADD A MEETING
/meet in 30 Test – starts in 30 minutes
/meet 14:30 Standup – today (tomorrow if 14:30 has passed)
/meet tomorrow 9:00 Review
/meet 2026-10-01 10:00 Planning
• Length: add it after the time, e.g. /meet 14:30 1h Workshop (default 30 min)
• Times are Bangkok time (${config.calendar.timezone})
• I confirm the meeting and tell you when its alert will come

🗑 UNDO
/meet undo – delete the last meeting you added from LINE
(Only works until the bot restarts; after that, delete it in Outlook.)

❓ /calendarhelp – show this guide`;

// Per-chat settings, keyed by user/group/room ID. Kept in memory; reset when the server restarts.
const chatLanguages = new Map();
// 'chat' (talk to Claude) or 'translate'. 1:1 chats start in chat mode; groups start in
// translate mode so the bot doesn't answer every message people send each other.
const chatModes = new Map();

// Chat-mode conversations: { messages, updatedAt }.
const conversations = new Map();
// A conversation idle this long starts fresh.
const CONVERSATION_IDLE_MS = 60 * 60 * 1000;
// Only the most recent messages are sent to Claude (10 exchanges).
const MAX_CONVERSATION_MESSAGES = 20;

// Per-user image conversations: { image, history, expiresAt }. Kept in memory only.
const imageSessions = new Map();
const IMAGE_SESSION_MS = 10 * 60 * 1000;
// Earlier follow-up exchanges beyond this are dropped (the image and first question are kept).
const MAX_FOLLOW_UPS = 8;

const HELP_TEXT = `🤖 Claude on LINE

💬 Chat mode (/chat): ask Claude anything. It remembers the conversation for an hour.
🌐 Translate mode (/translate): every message is translated.
• Default: into ${config.translation.defaultTarget} (text already in ${config.translation.defaultTarget} goes into ${config.translation.defaultSecondary})
• One-off: "to Japanese: good morning" or "แปลเป็นภาษาจีน สวัสดี"

📷 Questions about an image (1:1 chat only):
Send a photo, then ask about it. Follow-up questions work for 10 minutes.

${config.news.scheduleEnabled ? `📰 Morning world news:
/news on – get the top world news every day at ${config.news.time}
/news on Thai – same, in Thai (any language works)
/news off – stop the morning news
/news – get today's news now` : `📰 World news:
/news – get today's top world news
/news Thai – same, in Thai (any language works)`}

Commands:
/chat – talk to Claude (starts a new conversation)
/translate – translate every message
/lang Japanese – translate everything into Japanese
/lang – show the current setting
/lang reset – back to the default
/done – finish asking about an image
/help – show this message`;

// Handles a single webhook event.
export async function handleEvent(event) {
  switch (event.type) {
    case 'message':
      return handleMessage(event);
    case 'follow':
      return reply(event.replyToken, HELP_TEXT);
    case 'unfollow':
      console.log(`Unfollowed by ${event.source.userId}`);
      return null;
    default:
      return null;
  }
}

export function parseCommand(text) {
  const match = text.trim().match(/^\/(\w+)\s*(.*)$/s);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: match[2].trim() };
}

function chatId(source) {
  return source.groupId ?? source.roomId ?? source.userId;
}

function languagesFor(id) {
  const target = chatLanguages.get(id);
  return target
    ? { target, secondary: config.translation.defaultTarget === target ? config.translation.defaultSecondary : config.translation.defaultTarget }
    : { target: config.translation.defaultTarget, secondary: config.translation.defaultSecondary };
}

function modeFor(source) {
  return chatModes.get(chatId(source)) ?? (source.type === 'user' ? 'chat' : 'translate');
}

function activeImageSession(id) {
  const session = imageSessions.get(id);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    imageSessions.delete(id);
    return null;
  }
  return session;
}

async function handleMessage(event) {
  const { message, replyToken, source } = event;

  if (message.type === 'image') {
    // In groups, people share photos with each other; don't respond to every one.
    if (source.type !== 'user') return null;
    return handleImage(message, replyToken, source.userId);
  }

  if (message.type !== 'text') {
    return reply(replyToken, 'Please send text, or a photo to ask about.');
  }

  const command = parseCommand(message.text);
  if (command) {
    return handleCommand(command, replyToken, chatId(source), source);
  }

  showLoading(source);

  const id = chatId(source);
  const session = source.type === 'user' ? activeImageSession(source.userId) : null;
  let text;
  if (session) {
    text = await answerQuestion(session, message.text);
  } else if (modeFor(source) === 'chat') {
    text = await chatReply(id, message.text);
  } else {
    text = await translateText(message.text, languagesFor(id));
  }

  return reply(replyToken, text || '(empty response)');
}

async function handleImage(message, replyToken, userId) {
  try {
    const image = await downloadImage(message);
    imageSessions.set(userId, { image, history: [], expiresAt: Date.now() + IMAGE_SESSION_MS });
    return reply(replyToken, '📷 Got it! Ask me anything about this image.\nถามอะไรเกี่ยวกับรูปนี้ได้เลย\n\n(/done when finished)');
  } catch (err) {
    if (err instanceof ImageTooLarge) return reply(replyToken, 'That image is too large (max 5 MB).');
    if (err instanceof UnsupportedImage) return reply(replyToken, 'Sorry, I can only read JPEG, PNG, GIF, or WebP images.');
    throw err;
  }
}

async function answerQuestion(session, question) {
  const [first, ...followUps] = session.history;
  const recent = followUps.slice(-MAX_FOLLOW_UPS);
  const messages = first
    ? [{ role: 'user', content: [session.image, { type: 'text', text: first.question }] }, { role: 'assistant', content: first.answer }]
    : [];
  for (const turn of recent) {
    messages.push({ role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer });
  }
  messages.push({ role: 'user', content: first ? question : [session.image, { type: 'text', text: question }] });

  try {
    const answer = await askAboutImage(messages);
    session.history.push({ question, answer });
    session.expiresAt = Date.now() + IMAGE_SESSION_MS;
    return answer;
  } catch (err) {
    if (err instanceof AnswerRefused) return 'Sorry, I can’t help with that question.';
    return claudeErrorMessage(err);
  }
}

async function chatReply(id, text) {
  let conversation = conversations.get(id);
  if (!conversation || Date.now() - conversation.updatedAt > CONVERSATION_IDLE_MS) {
    conversation = { messages: [] };
    conversations.set(id, conversation);
  }

  const messages = [...conversation.messages, { role: 'user', content: text }];
  try {
    const answer = await chat(messages);
    // Keep whole user/assistant pairs so the history always starts with a user message.
    conversation.messages = [...messages, { role: 'assistant', content: answer }].slice(-MAX_CONVERSATION_MESSAGES);
    conversation.updatedAt = Date.now();
    return answer;
  } catch (err) {
    if (err instanceof ChatRefused) return 'Sorry, I can’t help with that.';
    return claudeErrorMessage(err);
  }
}

async function translateText(text, languages) {
  try {
    return await translate(text, languages);
  } catch (err) {
    if (err instanceof TranslationRefused) return 'Sorry, I can’t translate that message.';
    return claudeErrorMessage(err);
  }
}

function claudeErrorMessage(err) {
  if (err instanceof Anthropic.RateLimitError) {
    console.error('Claude rate limited:', err.message);
    return 'The assistant is busy right now. Please try again in a moment.';
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`Claude API error ${err.status}:`, err.message);
    return 'Something went wrong. Please try again later.';
  }
  throw err;
}

function handleCommand({ name, arg }, replyToken, id, source) {
  if (name === 'chat') {
    chatModes.set(id, 'chat');
    conversations.delete(id);
    return reply(replyToken, '💬 Chat mode: ask me anything! (New conversation started.)\n\nSend /translate to go back to translating.');
  }
  if (name === 'translate') {
    chatModes.set(id, 'translate');
    const { target } = languagesFor(id);
    return reply(replyToken, `🌐 Translate mode: messages will be translated into ${target}.\n\nSend /chat to talk to Claude.`);
  }
  if (name === 'lang') {
    if (!arg) {
      const { target, secondary } = languagesFor(id);
      return reply(replyToken, `Translating into ${target} (text already in ${target} goes into ${secondary}).`);
    }
    if (arg.toLowerCase() === 'reset') {
      chatLanguages.delete(id);
      return reply(replyToken, `Reset. Translating into ${config.translation.defaultTarget}.`);
    }
    const language = arg.slice(0, 50);
    chatLanguages.set(id, language);
    chatModes.set(id, 'translate');
    return reply(replyToken, `🌐 Translate mode: messages in this chat will be translated into ${language}.\n\nSend /chat to talk to Claude.`);
  }
  if (name === 'myid') {
    // Shows the sender their own LINE user ID (e.g. for CALENDAR_ALERT_TO).
    return reply(replyToken, `Your LINE user ID:\n${source.userId}`);
  }
  if (name === 'calendar') {
    return handleCalendarCommand(replyToken, source);
  }
  if (name === 'meet') {
    return handleMeetCommand(arg, replyToken, source);
  }
  if (name === 'inbox' || name === 'mail') {
    return handleInboxCommand(replyToken, source);
  }
  if (name === 'cancel') {
    return handleCancelCommand(replyToken, source);
  }
  if (name === 'email' || name === 'send') {
    return handleEmailCommand(name, arg, replyToken, source);
  }
  if (name === 'fb' || name === 'fbphoto' || name === 'post') {
    return handleFacebookCommand(name, arg, replyToken, source);
  }
  if (name === 'fbhelp') {
    return reply(replyToken, isCalendarOwner(source) ? FACEBOOK_HELP : HELP_TEXT);
  }
  if (name === 'emailhelp' || name === 'mailhelp') {
    return reply(replyToken, isCalendarOwner(source) ? EMAIL_COMMANDS_HELP : HELP_TEXT);
  }
  if (name === 'calendarhelp' || name === 'calhelp') {
    return reply(replyToken, isCalendarOwner(source) ? CALENDAR_COMMANDS_HELP : HELP_TEXT);
  }
  if (name === 'news') {
    return handleNewsCommand(arg, replyToken, id);
  }
  if (name === 'done') {
    const hadImage = imageSessions.delete(id);
    const back = modeFor(source) === 'chat' ? 'chat' : 'translation';
    return reply(replyToken, hadImage ? `Done with the image. Back to ${back}.` : `You're in ${back} mode.`);
  }
  // Owner-only commands aren't listed for everyone; point the owner to them.
  if (isCalendarOwner(source)) {
    return reply(replyToken, `${HELP_TEXT}\n\n🔒 Your private commands:\n/emailhelp – all email commands\n/calendarhelp – all calendar commands\n/fbhelp – Facebook Page posting`);
  }
  return reply(replyToken, HELP_TEXT);
}

// The calendar is private: only the owner (CALENDAR_ALERT_TO), and only in a 1:1 chat.
function isCalendarOwner(source) {
  return Boolean(config.calendar.alertTo) && source.type === 'user' && source.userId === config.calendar.alertTo;
}

async function handleMeetCommand(arg, replyToken, source) {
  if (!isCalendarOwner(source)) return reply(replyToken, HELP_TEXT);
  if (!arg) return reply(replyToken, MEET_HELP);

  try {
    if (arg.toLowerCase() === 'undo') {
      const last = createdMeetings.pop();
      if (!last) return reply(replyToken, 'No meetings added from LINE to undo.');
      await deleteEvent(last.id);
      return reply(replyToken, `🗑 Deleted "${last.subject}" (${formatDateTime(last.start)}).`);
    }

    const now = new Date();
    const parsed = parseMeetCommand(arg, now);
    if (parsed.error === 'past') return reply(replyToken, 'That time has already passed.');
    if (parsed.error) return reply(replyToken, `Sorry, I couldn't read that time.\n\n${MEET_HELP}`);

    const event = await createEvent(parsed);
    createdMeetings.push(event);

    const alertAt = new Date(event.start.getTime() - config.calendar.leadMinutes * 60000);
    const alertNote = alertAt <= now ? 'within a minute' : `at ${formatDateTime(alertAt)}`;
    return reply(
      replyToken,
      `✅ Added to your calendar:\n📅 ${event.subject}\n🕐 ${formatDateTime(event.start)} (${parsed.minutes} min)\n\n⏰ You should get the alert ${alertNote}.\n/meet undo to delete it.`,
    );
  } catch (err) {
    if (err instanceof NotSignedIn) return reply(replyToken, '📅 Not connected to your calendar. Run "npm run microsoft-login" on the server.');
    if (err instanceof NoWriteAccess) return reply(replyToken, '📅 The bot can read your calendar but not add to it yet. Run "npm run microsoft-login" on the server and approve the new permission.');
    console.error('Calendar update failed:', err.message);
    return reply(replyToken, 'Could not update your calendar right now. Please try again later.');
  }
}

// How to sign in on the production server (the bot runs as the container "nodejs_lineoa").
const SIGN_IN_COMMAND = 'docker exec -it nodejs_lineoa npm run microsoft-login';

// Explains what's missing when this server can't use a Microsoft permission yet, or returns null.
function missingMicrosoftAccess(permission, action) {
  if (!isSignedIn()) {
    return `This server isn’t connected to your Outlook account yet. Sign in once on the server:\n${SIGN_IN_COMMAND}`;
  }
  if (!hasPermission(permission)) {
    return `The bot isn’t allowed to ${action} yet: this server’s sign-in is from before that feature. Sign in again on the server and click Accept:\n${SIGN_IN_COMMAND}`;
  }
  return null;
}

async function handleInboxCommand(replyToken, source) {
  if (!isCalendarOwner(source)) return reply(replyToken, HELP_TEXT);
  const missing = missingMicrosoftAccess('Mail.Read', 'read your email');
  if (missing) return reply(replyToken, `📬 ${missing}`);
  showLoading(source);
  try {
    const texts = formatInbox(await fetchUnreadToday(new Date()));
    return client.replyMessage({ replyToken, messages: texts.map((text) => ({ type: 'text', text })) });
  } catch (err) {
    if (err instanceof NotSignedIn) return reply(replyToken, '📬 Not connected to your Outlook account. Run "npm run microsoft-login" on the server.');
    console.error('Inbox check failed:', err.message);
    return reply(replyToken, 'Could not check your email right now. Please try again later.');
  }
}

// /cancel discards whatever is waiting for confirmation (an email and/or a Facebook post).
function handleCancelCommand(replyToken, source) {
  if (!isCalendarOwner(source)) return reply(replyToken, HELP_TEXT);
  const discarded = [];
  if (pendingEmail) discarded.push('email (not sent)');
  if (pendingFacebookPost) discarded.push('Facebook post (not published)');
  pendingEmail = null;
  pendingFacebookPost = null;
  return reply(replyToken, discarded.length ? `🗑 Discarded: ${discarded.join(' and ')}.` : 'There’s nothing waiting to be sent.');
}

async function handleFacebookCommand(name, arg, replyToken, source) {
  if (!isCalendarOwner(source)) return reply(replyToken, HELP_TEXT);
  if (!isFacebookConfigured()) {
    return reply(replyToken, '📘 Facebook posting isn’t set up on this server yet. Add FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN to .env (see README "Posting to Facebook") and restart.');
  }

  if (name === 'post') {
    if (!pendingFacebookPost || Date.now() > pendingFacebookPost.expiresAt) {
      pendingFacebookPost = null;
      return reply(replyToken, 'There’s no Facebook post waiting to be published (drafts expire after 10 minutes).');
    }
    const draft = pendingFacebookPost;
    pendingFacebookPost = null;
    try {
      const url = draft.image ? await postPhoto({ image: draft.image, caption: draft.message }) : await postText(draft);
      return reply(replyToken, `✅ Posted to your Facebook Page:\n${url}`);
    } catch (err) {
      if (err instanceof FacebookTokenInvalid) {
        return reply(replyToken, '📘 Facebook rejected the Page access token (expired or revoked). Create a new one with "npm run facebook-token" and update .env. Nothing was posted.');
      }
      if (err instanceof FacebookNotConfigured) return reply(replyToken, '📘 Facebook posting isn’t set up on this server yet.');
      console.error('Facebook post failed:', err.message);
      return reply(replyToken, `Facebook didn’t accept the post, so nothing was published.\n(${err.message.slice(0, 300)})`);
    }
  }

  if (name === 'fbphoto') {
    const session = source.type === 'user' ? activeImageSession(source.userId) : null;
    if (!session) return reply(replyToken, '📷 Send me the photo first, then /fbphoto with your caption (within 10 minutes).');
    pendingFacebookPost = { image: session.image, message: arg.trim().slice(0, 63206), expiresAt: Date.now() + FACEBOOK_CONFIRM_MS };
    return reply(replyToken, `📘 Ready to post a photo to your Facebook Page${pendingFacebookPost.message ? ` with this caption:\n\n${pendingFacebookPost.message.slice(0, 1500)}` : ' (no caption).'}\n\n👉 Reply /post to publish it, or /cancel.`);
  }

  // /fb <text>
  if (!arg) return reply(replyToken, FACEBOOK_HELP);
  const draft = parseFacebookPost(arg);
  if (draft.error === 'too-long') return reply(replyToken, 'That post is too long for Facebook.');
  if (draft.error) return reply(replyToken, FACEBOOK_HELP);

  pendingFacebookPost = { ...draft, expiresAt: Date.now() + FACEBOOK_CONFIRM_MS };
  const preview = draft.message.length > 1500 ? `${draft.message.slice(0, 1500)}…` : draft.message;
  return reply(replyToken, `📘 Ready to post to your Facebook Page:\n\n${preview}${draft.link ? `\n\n🔗 Link preview: ${draft.link}` : ''}\n\n👉 Reply /post to publish it, or /cancel.`);
}

async function handleEmailCommand(name, arg, replyToken, source) {
  if (!isCalendarOwner(source)) return reply(replyToken, HELP_TEXT);

  if (name === 'send') {
    if (!pendingEmail || Date.now() > pendingEmail.expiresAt) {
      pendingEmail = null;
      return reply(replyToken, 'There’s no email waiting to be sent (drafts expire after 10 minutes).');
    }
    const draft = pendingEmail;
    pendingEmail = null;
    try {
      await sendEmail(draft);
      return reply(replyToken, `✅ Email sent to ${draft.to.join(', ')}.\nA copy is in your Sent folder.`);
    } catch (err) {
      if (err instanceof NotSignedIn) return reply(replyToken, '✉️ Not connected to your Outlook account. Run "npm run microsoft-login" on the server.');
      if (err instanceof NoWriteAccess) return reply(replyToken, '✉️ The bot isn’t allowed to send email yet. Run "npm run microsoft-login" on the server and approve the new permission.');
      console.error('Email send failed:', err.message);
      return reply(replyToken, 'The email could not be sent. Nothing was sent; please try again later.');
    }
  }

  // /email: parse and show a preview.
  if (!arg) return reply(replyToken, EMAIL_HELP);
  const missing = missingMicrosoftAccess('Mail.Send', 'send email');
  if (missing) return reply(replyToken, `✉️ ${missing}`);
  const draft = parseEmailCommand(arg);
  if (draft.error === 'address') return reply(replyToken, `That doesn’t look like an email address: ${draft.detail}`);
  if (draft.error === 'too-many') return reply(replyToken, 'Please send to 10 recipients or fewer.');
  if (draft.error) return reply(replyToken, EMAIL_HELP);

  pendingEmail = { ...draft, expiresAt: Date.now() + EMAIL_CONFIRM_MS };
  const preview = draft.body.length > 1500 ? `${draft.body.slice(0, 1500)}…` : draft.body;
  return reply(
    replyToken,
    `✉️ Ready to send:\n\nTo: ${draft.to.join(', ')}\nSubject: ${draft.subject}\n\n${preview}\n\n👉 Reply /send to send it, or /cancel.`,
  );
}

async function handleCalendarCommand(replyToken, source) {
  if (!isCalendarOwner(source)) return reply(replyToken, HELP_TEXT);
  try {
    const now = new Date();
    return reply(replyToken, formatAgenda(await fetchEvents(now, endOfToday(now)), now));
  } catch (err) {
    if (err instanceof NotSignedIn) return reply(replyToken, '📅 Not connected to your calendar. Run "npm run microsoft-login" on the server.');
    console.error('Calendar lookup failed:', err.message);
    return reply(replyToken, 'Could not read your calendar right now. Please try again later.');
  }
}

function handleNewsCommand(arg, replyToken, id) {
  const [action, ...rest] = arg.split(/\s+/);
  const subscription = getSubscription(id);

  if (action.toLowerCase() === 'on') {
    const language = rest.join(' ').slice(0, 50) || subscription?.language || config.news.defaultLanguage;
    subscribe(id, language);
    if (!config.news.scheduleEnabled) {
      return reply(replyToken, `The daily morning news is turned off at the moment. I've saved your choice (${language}) for when it's back on.\n\nYou can still send /news any time to get today's news.`);
    }
    return reply(replyToken, `📰 Subscribed! You'll get the top world news in ${language} every day at ${config.news.time} (${config.news.timezone}).\n\nSend /news off to stop.`);
  }
  if (action.toLowerCase() === 'off') {
    const existed = unsubscribe(id);
    return reply(replyToken, existed ? 'Unsubscribed from the morning news.' : "You're not subscribed to the morning news.");
  }

  // "/news" (or "/news <language>"): send today's digest now. Searching takes a while,
  // longer than a reply token stays valid, so acknowledge now and push the digest when ready.
  const language = arg || subscription?.language || config.news.defaultLanguage;
  sendDigestNow(id, language);
  const status = !config.news.scheduleEnabled
    ? ''
    : subscription
    ? `You're subscribed (${subscription.language}, daily at ${config.news.time}).`
    : 'Tip: send /news on to get this every morning.';
  return reply(replyToken, `⏳ Gathering today's top world news… this can take a minute.${status ? `\n\n${status}` : ''}`);
}

async function sendDigestNow(id, language) {
  let text;
  try {
    text = await getDigest(language);
  } catch (err) {
    if (err instanceof DigestRefused) {
      text = 'Sorry, I couldn’t put together the news right now.';
    } else if (err instanceof Anthropic.APIError) {
      text = claudeErrorMessage(err);
    } else {
      console.error('News digest failed:', err);
      text = 'Sorry, I couldn’t put together the news right now.';
    }
  }
  try {
    await client.pushMessage({ to: id, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error(`News push to ${id} failed:`, err.status ?? '', err.body ?? err.message);
  }
}

// Shows the "typing" indicator while Claude works (only supported in 1:1 chats).
function showLoading(source) {
  if (source.type === 'user') {
    client.showLoadingAnimation({ chatId: source.userId, loadingSeconds: 30 }).catch(() => {});
  }
}

function reply(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}
