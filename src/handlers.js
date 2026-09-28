import Anthropic from '@anthropic-ai/sdk';
import { client } from './line.js';
import { config } from './config.js';
import { translate, TranslationRefused } from './translate.js';
import { chat, ChatRefused } from './chat.js';
import { downloadImage, askAboutImage, ImageTooLarge, UnsupportedImage, AnswerRefused } from './vision.js';
import { getDigest, DigestRefused } from './news.js';
import { subscribe, unsubscribe, getSubscription } from './store.js';

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

📰 Morning world news:
/news on – get the top world news every day at ${config.news.time}
/news on Thai – same, in Thai (any language works)
/news off – stop the morning news
/news – get today's news now

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
  if (name === 'news') {
    return handleNewsCommand(arg, replyToken, id);
  }
  if (name === 'done') {
    const hadImage = imageSessions.delete(id);
    const back = modeFor(source) === 'chat' ? 'chat' : 'translation';
    return reply(replyToken, hadImage ? `Done with the image. Back to ${back}.` : `You're in ${back} mode.`);
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
