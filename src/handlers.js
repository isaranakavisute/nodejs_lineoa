import Anthropic from '@anthropic-ai/sdk';
import { client } from './line.js';
import { config } from './config.js';
import { translate, TranslationRefused } from './translate.js';
import { downloadImage, askAboutImage, ImageTooLarge, UnsupportedImage, AnswerRefused } from './vision.js';
import { getDigest, DigestRefused } from './news.js';
import { subscribe, unsubscribe, getSubscription } from './store.js';

// Per-chat target language, keyed by user/group/room ID. Resets when the server restarts.
const chatLanguages = new Map();

// Per-user image conversations: { image, history, expiresAt }. Kept in memory only.
const imageSessions = new Map();
const IMAGE_SESSION_MS = 10 * 60 * 1000;
// Earlier follow-up exchanges beyond this are dropped (the image and first question are kept).
const MAX_FOLLOW_UPS = 8;

const HELP_TEXT = `🌐 Translation bot

Send any message and I'll translate it.
• Default: into ${config.translation.defaultTarget} (text already in ${config.translation.defaultTarget} goes into ${config.translation.defaultSecondary})
• One-off: "to Japanese: good morning" or "แปลเป็นภาษาจีน สวัสดี"

📷 Questions about an image (1:1 chat only):
Send a photo, then ask about it. Follow-up questions work for 10 minutes.

📰 Morning world news:
/news on – get the top world news every day at ${config.news.time}
/news on Thai – same, in Thai (any language works)
/news off – stop the morning news
/news – get today's news now

Commands:
/lang Japanese – always translate into Japanese in this chat
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
    return reply(replyToken, 'Please send text to translate, or a photo to ask about.');
  }

  const command = parseCommand(message.text);
  if (command) {
    return handleCommand(command, replyToken, chatId(source));
  }

  showLoading(source);

  const session = source.type === 'user' ? activeImageSession(source.userId) : null;
  const text = session
    ? await answerQuestion(session, message.text)
    : await translateText(message.text, languagesFor(chatId(source)));

  return reply(replyToken, text || '(empty response)');
}

async function handleImage(message, replyToken, userId) {
  try {
    const image = await downloadImage(message);
    imageSessions.set(userId, { image, history: [], expiresAt: Date.now() + IMAGE_SESSION_MS });
    return reply(replyToken, '📷 Got it! Ask me anything about this image.\nถามอะไรเกี่ยวกับรูปนี้ได้เลย\n\n(/done to go back to translation)');
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

function handleCommand({ name, arg }, replyToken, id) {
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
    return reply(replyToken, `OK! Messages in this chat will be translated into ${language}.`);
  }
  if (name === 'news') {
    return handleNewsCommand(arg, replyToken, id);
  }
  if (name === 'done') {
    const hadImage = imageSessions.delete(id);
    return reply(replyToken, hadImage ? 'Done with the image. Back to translation.' : 'Translation mode is on.');
  }
  return reply(replyToken, HELP_TEXT);
}

function handleNewsCommand(arg, replyToken, id) {
  const [action, ...rest] = arg.split(/\s+/);
  const subscription = getSubscription(id);

  if (action.toLowerCase() === 'on') {
    const language = rest.join(' ').slice(0, 50) || subscription?.language || config.news.defaultLanguage;
    subscribe(id, language);
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
  const status = subscription
    ? `You're subscribed (${subscription.language}, daily at ${config.news.time}).`
    : 'Tip: send /news on to get this every morning.';
  return reply(replyToken, `⏳ Gathering today's top world news… this can take a minute.\n\n${status}`);
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
