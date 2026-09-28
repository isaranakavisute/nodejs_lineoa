import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// News subscribers, saved to disk so they survive restarts: { [chatId]: { language } }
const file = path.join(config.dataDir, 'news-subscribers.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

let subscribers = load();

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Write to a temp file first so a crash mid-write can't corrupt the list.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(subscribers, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

export function subscribe(chatId, language) {
  subscribers[chatId] = { language };
  save();
}

export function unsubscribe(chatId) {
  const existed = chatId in subscribers;
  delete subscribers[chatId];
  save();
  return existed;
}

export function getSubscription(chatId) {
  return subscribers[chatId] ?? null;
}

export function allSubscriptions() {
  return Object.entries(subscribers).map(([chatId, sub]) => ({ chatId, ...sub }));
}
