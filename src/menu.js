// The owner's menu: Rich Menu taps, sub-menus of buttons (quick replies), and step-by-step
// guided flows for commands that need typed input. Every flow ends by running the same
// command you could type yourself (e.g. /email, /fb, /meet), so behaviour is identical.
import { client } from './line.js';
import { config } from './config.js';
import { parseEmailCommand } from './mail.js';
import { parseMeetCommand, formatDateTime } from './calendar.js';
import { runCommand, rememberImage } from './handlers.js';

// A guided flow in progress, per owner: { flow, step, data, expiresAt }.
const flows = new Map();
const FLOW_MS = 15 * 60 * 1000;

const CANCEL = { label: '❌ Cancel', data: { wiz: 'cancel' } };

export function isOwner(source) {
  return Boolean(config.calendar.alertTo) && source.type === 'user' && source.userId === config.calendar.alertTo;
}

// ---- Replies with buttons ----

// Option shapes: { label, cmd } runs a command; { label, menu } opens a sub-menu; { label, flow } starts a
// guided flow; { label, text } sends that text as your answer; { label, data } sends postback data;
// { label, camera: true } / { label, cameraRoll: true } open the camera or photo gallery.
function toAction(option) {
  const label = option.label.slice(0, 20);
  if (option.camera) return { type: 'camera', label };
  if (option.cameraRoll) return { type: 'cameraRoll', label };
  if (option.text !== undefined) return { type: 'message', label, text: option.text };
  const data = option.data ?? (option.cmd ? { cmd: option.cmd } : option.menu ? { menu: option.menu } : { flow: option.flow });
  return { type: 'postback', label, data: new URLSearchParams(data).toString(), displayText: option.label };
}

export function replyWithOptions(replyToken, text, options) {
  return client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text,
      quickReply: { items: options.slice(0, 13).map((o) => ({ type: 'action', action: toAction(o) })) },
    }],
  });
}

// ---- Menus ----

export const MAIN_MENU = [
  { label: '📬 Inbox', cmd: '/inbox' },
  { label: '✉️ Email', flow: 'email' },
  { label: '📅 Calendar', menu: 'calendar' },
  { label: '📘 Facebook', menu: 'facebook' },
  { label: '💬 Chat / Translate', menu: 'modes' },
  { label: '❓ Help', menu: 'help' },
];

const SUB_MENUS = {
  main: { text: '📋 What would you like to do?', options: MAIN_MENU },
  calendar: {
    text: '📅 Calendar',
    options: [
      { label: '📋 Today', cmd: '/calendar today' },
      { label: '🌅 Tomorrow', cmd: '/calendar tomorrow' },
      { label: '🗓 Week', cmd: '/calendar week' },
      { label: '➕ Add a meeting', flow: 'meet' },
      { label: '↩️ Undo last added', cmd: '/meet undo' },
      { label: '❓ Calendar help', cmd: '/calendarhelp' },
    ],
  },
  facebook: {
    text: '📘 What would you like to post to your Facebook Page?',
    options: [
      { label: '📝 Text post', flow: 'fbtext' },
      { label: '📷 Photo post', flow: 'fbphoto' },
      { label: '❓ Facebook help', cmd: '/fbhelp' },
    ],
  },
  modes: {
    text: '💬 Chat with Claude, or 🌐 translate everything into a language:',
    options: [
      { label: '💬 Chat mode', cmd: '/chat' },
      { label: '🌐 English', cmd: '/lang English' },
      { label: '🌐 ไทย Thai', cmd: '/lang Thai' },
      { label: '🌐 日本語 Japanese', cmd: '/lang Japanese' },
      { label: '🌐 中文 Chinese', cmd: '/lang Chinese' },
      { label: '🌐 한국어 Korean', cmd: '/lang Korean' },
      { label: '🌐 Other language', flow: 'lang' },
      { label: '📰 Today\'s news', cmd: '/news' },
    ],
  },
  help: {
    text: '❓ Which guide?',
    options: [
      { label: '📧 Email help', cmd: '/emailhelp' },
      { label: '📅 Calendar help', cmd: '/calendarhelp' },
      { label: '📘 Facebook help', cmd: '/fbhelp' },
      { label: '📋 All commands', cmd: '/help' },
    ],
  },
};

export function showMenu(name, replyToken) {
  const menu = SUB_MENUS[name] ?? SUB_MENUS.main;
  return replyWithOptions(replyToken, menu.text, menu.options);
}

// ---- Guided flows ----

const MEET_WHEN = [
  { label: 'In 30 min', text: 'in 30' },
  { label: 'In 1 hour', text: 'in 60' },
  { label: 'In 2 hours', text: 'in 120' },
  { label: 'Tomorrow 9:00', text: 'tomorrow 9:00' },
  { label: 'Tomorrow 14:00', text: 'tomorrow 14:00' },
  CANCEL,
];
const MEET_LENGTH = [
  { label: '30 min', text: '30m' },
  { label: '1 hour', text: '1h' },
  { label: '1.5 hours', text: '90m' },
  { label: '2 hours', text: '2h' },
  CANCEL,
];

// The question for each step: [text, options].
const STEPS = {
  email: {
    to: ['✉️ Who should I send it to?\nType an email address (several: separate with commas).', [CANCEL]],
    subject: ["What's the subject?", [CANCEL]],
    body: ['Type your message (it can be several lines).', [CANCEL]],
  },
  meet: {
    when: ['📅 When is the meeting?\nTap a button, or type a time like 14:30, tomorrow 9:00, or 2026-10-01 10:00.', MEET_WHEN],
    length: ['How long is it?', MEET_LENGTH],
    title: ["What's it called?", [{ label: 'No title', data: { wiz: 'skip' } }, CANCEL]],
  },
  fbtext: {
    text: ['📝 Type your Facebook post (it can be several lines; a web address becomes a link preview).', [CANCEL]],
  },
  fbphoto: {
    photo: ['📷 Send the photo you want to post.', [{ label: '📷 Camera', camera: true }, { label: '🖼 Gallery', cameraRoll: true }, CANCEL]],
    caption: ['Add a caption? Type it, or tap No caption.', [{ label: 'No caption', data: { wiz: 'skip' } }, CANCEL]],
  },
  lang: {
    lang: ['🌐 Which language should I translate into? Type its name (e.g. Vietnamese, French, ภาษาลาว).', [CANCEL]],
  },
};

const FIRST_STEP = { email: 'to', meet: 'when', fbtext: 'text', fbphoto: 'photo', lang: 'lang' };

function ask(replyToken, flow, step, prefix = '') {
  const [text, options] = STEPS[flow][step];
  return replyWithOptions(replyToken, `${prefix}${text}`, options);
}

export function startFlow(flow, replyToken, userId) {
  if (!FIRST_STEP[flow]) return showMenu('main', replyToken);
  flows.set(userId, { flow, step: FIRST_STEP[flow], data: {}, expiresAt: Date.now() + FLOW_MS });
  return ask(replyToken, flow, FIRST_STEP[flow]);
}

export function endFlow(userId) {
  flows.delete(userId);
}

function activeFlow(userId) {
  const state = flows.get(userId);
  if (state && Date.now() > state.expiresAt) {
    flows.delete(userId);
    return null;
  }
  return state ?? null;
}

// Runs a finished flow's command; the flow is over first so the command isn't treated as an answer.
function finish(userId, commandText, replyToken, source) {
  flows.delete(userId);
  return runCommand(commandText, replyToken, source);
}

const SKIP = Symbol('skip');

// Handles a typed answer (or SKIP). Returns false if no flow is waiting for text.
export async function handleFlowText(text, replyToken, source) {
  const userId = source.userId;
  const state = activeFlow(userId);
  if (!state) return false;
  const { flow, step, data } = state;
  const answer = text === SKIP ? '' : text.trim();
  state.expiresAt = Date.now() + FLOW_MS;
  const next = (nextStep, prefix) => {
    state.step = nextStep;
    return ask(replyToken, flow, nextStep, prefix);
  };

  if (flow === 'email') {
    if (step === 'to') {
      const check = parseEmailCommand(`${answer}\nsubject\nbody`);
      if (check.error) return ask(replyToken, flow, 'to', `⚠️ ${check.detail ? `"${check.detail}" isn't an email address.` : 'Please type an email address.'}\n\n`);
      data.to = answer;
      return next('subject');
    }
    if (step === 'subject') {
      if (!answer) return ask(replyToken, flow, 'subject');
      data.subject = answer.split('\n')[0];
      return next('body');
    }
    if (!answer) return ask(replyToken, flow, 'body');
    return finish(userId, `/email ${data.to}\n${data.subject}\n${answer}`, replyToken, source);
  }

  if (flow === 'meet') {
    if (step === 'when') {
      const parsed = parseMeetCommand(answer, new Date());
      if (parsed.error === 'past') return ask(replyToken, flow, 'when', '⚠️ That time has already passed.\n\n');
      if (parsed.error) return ask(replyToken, flow, 'when', "⚠️ I couldn't read that time.\n\n");
      data.when = answer;
      return next('length');
    }
    if (step === 'length') {
      if (!/^\d+\s*(m|min|h)$/i.test(answer)) return ask(replyToken, flow, 'length', '⚠️ Tap a button, or type a length like 45m or 1h.\n\n');
      data.length = answer.replace(/\s+/g, '');
      return next('title');
    }
    if (step === 'title') {
      data.title = answer.split('\n')[0] || 'Meeting';
      const parsed = parseMeetCommand(`${data.when} ${data.length} ${data.title}`, new Date());
      if (parsed.error) return startFlow('meet', replyToken, userId);
      state.step = 'confirm';
      return replyWithOptions(
        replyToken,
        `📅 Add this meeting?\n\n${parsed.subject}\n🕐 ${formatDateTime(parsed.start)} (${parsed.minutes} min)`,
        [{ label: '✅ Add', data: { wiz: 'confirm' } }, CANCEL],
      );
    }
    return replyWithOptions(replyToken, 'Tap ✅ Add to add the meeting, or ❌ Cancel.', [{ label: '✅ Add', data: { wiz: 'confirm' } }, CANCEL]);
  }

  if (flow === 'fbtext') {
    if (!answer) return ask(replyToken, flow, 'text');
    return finish(userId, `/fb ${answer}`, replyToken, source);
  }

  if (flow === 'fbphoto') {
    if (step === 'photo') return ask(replyToken, flow, 'photo', '⚠️ I need a photo first.\n\n');
    return finish(userId, answer ? `/fbphoto ${answer}` : '/fbphoto', replyToken, source);
  }

  if (flow === 'lang') {
    if (!answer) return ask(replyToken, flow, 'lang');
    return finish(userId, `/lang ${answer}`, replyToken, source);
  }

  return false;
}

// Handles a photo sent during a flow. Returns false if no flow is waiting for a photo.
export async function handleFlowImage(message, replyToken, source) {
  const state = activeFlow(source.userId);
  if (!state || state.flow !== 'fbphoto' || state.step !== 'photo') return false;
  const error = await rememberImage(message, source.userId);
  if (error) return ask(replyToken, 'fbphoto', 'photo', `⚠️ ${error}\n\n`);
  state.step = 'caption';
  state.expiresAt = Date.now() + FLOW_MS;
  return ask(replyToken, 'fbphoto', 'caption', '📷 Got the photo.\n');
}

// Taps on the Rich Menu and on buttons arrive as postback events.
export async function handlePostback(event) {
  const { replyToken, source } = event;
  if (!isOwner(source)) return null;
  const params = new URLSearchParams(event.postback.data);

  if (params.has('cmd')) {
    endFlow(source.userId);
    return runCommand(params.get('cmd'), replyToken, source);
  }
  if (params.has('menu')) {
    endFlow(source.userId);
    return showMenu(params.get('menu'), replyToken);
  }
  if (params.has('flow')) return startFlow(params.get('flow'), replyToken, source.userId);

  const wiz = params.get('wiz');
  if (wiz === 'cancel') {
    const hadFlow = Boolean(activeFlow(source.userId));
    endFlow(source.userId);
    return replyWithOptions(replyToken, hadFlow ? '❌ Cancelled. Nothing was sent.' : 'Nothing to cancel.', [{ label: '📋 Menu', menu: 'main' }]);
  }
  if (wiz === 'skip') return handleFlowText(SKIP, replyToken, source);
  if (wiz === 'confirm') {
    const state = activeFlow(source.userId);
    if (state?.flow === 'meet' && state.step === 'confirm') {
      const { when, length, title } = state.data;
      return finish(source.userId, `/meet ${when} ${length} ${title}`, replyToken, source);
    }
    return replyWithOptions(replyToken, 'That has expired. Start again from the menu.', [{ label: '📋 Menu', menu: 'main' }]);
  }
  return showMenu('main', replyToken);
}
