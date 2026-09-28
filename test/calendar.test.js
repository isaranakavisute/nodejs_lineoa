import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineoa-cal-'));
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.DATA_DIR = dataDir;
process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.CALENDAR_ALERT_TO = 'Uowner';
process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';

const { dueForAlert, formatAlert, endOfToday, alertKey } = await import('../src/calendar.js');
const { checkCalendar } = await import('../src/calendarScheduler.js');
const { client } = await import('../src/line.js');

const now = new Date('2026-09-28T02:00:00Z'); // 09:00 in Bangkok
const at = (iso) => new Date(iso);
const event = (id, start, extra = {}) => ({
  id, subject: `Meeting ${id}`, start: at(start), end: new Date(at(start).getTime() + 30 * 60000),
  isAllDay: false, location: '', joinUrl: '', ...extra,
});

test('alerts meetings starting within the next hour, once', () => {
  const events = [
    event('past', '2026-09-28T01:30:00Z'),
    event('in30', '2026-09-28T02:30:00Z'),
    event('in60', '2026-09-28T03:00:00Z'),
    event('in61', '2026-09-28T03:01:00Z'),
    event('allday', '2026-09-28T02:10:00Z', { isAllDay: true }),
  ];
  assert.deepEqual(dueForAlert(events, now, new Set(), 60).map((e) => e.id), ['in30', 'in60']);
  assert.deepEqual(dueForAlert(events, now, new Set([alertKey(events[1])]), 60).map((e) => e.id), ['in60']);
});

test('a rescheduled meeting is alerted again', () => {
  const original = event('m', '2026-09-28T02:30:00Z');
  const moved = event('m', '2026-09-28T02:45:00Z');
  assert.equal(dueForAlert([moved], now, new Set([alertKey(original)]), 60).length, 1);
});

test('formats times in the calendar time zone', () => {
  const text = formatAlert([event('x', '2026-09-28T03:00:00Z', { location: 'Room 5' })], now);
  assert.match(text, /Meeting in 1 hour/);
  assert.match(text, /10:00–10:30/);
  assert.match(text, /Room 5/);
});

test('end of today is midnight in Bangkok', () => {
  assert.equal(endOfToday(now).toISOString(), '2026-09-28T17:00:00.000Z');
  assert.equal(endOfToday(at('2026-09-28T18:00:00Z')).toISOString(), '2026-09-29T17:00:00.000Z');
});

test('checkCalendar pushes one alert and does not repeat it', async () => {
  fs.writeFileSync(path.join(dataDir, 'microsoft-token.json'), JSON.stringify({ refreshToken: 'r1' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/token')
      ? { access_token: 'a', refresh_token: 'r2', expires_in: 3600 }
      : { value: [{ id: 'e1', subject: 'Design review', start: { dateTime: '2026-09-28T02:45:00.0000000' }, end: { dateTime: '2026-09-28T03:30:00.0000000' }, isAllDay: false, isCancelled: false, responseStatus: { response: 'accepted' }, location: { displayName: 'Room 3' } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const pushed = [];
  client.pushMessage = async (msg) => pushed.push(msg);
  try {
    await checkCalendar(now);
    await checkCalendar(new Date(now.getTime() + 60000));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].to, 'Uowner');
  assert.match(pushed[0].messages[0].text, /Design review[\s\S]*09:45–10:30[\s\S]*Room 3/);
  assert.match(pushed[0].messages[0].text, /in 45 min/);
  // The rotated refresh token was saved.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'microsoft-token.json'), 'utf8')).refreshToken, 'r2');
});

test('/meet parses times in Bangkok', async () => {
  const { parseMeetCommand } = await import('../src/calendar.js');
  const iso = (r) => r.start.toISOString();
  // now = 09:00 Bangkok on 28 Sep
  let r = parseMeetCommand('in 30 Quick test', now);
  assert.equal(iso(r), '2026-09-28T02:30:00.000Z'); assert.equal(r.subject, 'Quick test'); assert.equal(r.minutes, 30);
  r = parseMeetCommand('14:30 1h Workshop', now);
  assert.equal(iso(r), '2026-09-28T07:30:00.000Z'); assert.equal(r.minutes, 60); assert.equal(r.subject, 'Workshop');
  r = parseMeetCommand('8:00', now); // already passed today → tomorrow
  assert.equal(iso(r), '2026-09-29T01:00:00.000Z'); assert.equal(r.subject, 'Test meeting');
  r = parseMeetCommand('tomorrow 9.15 45m Review', now);
  assert.equal(iso(r), '2026-09-29T02:15:00.000Z'); assert.equal(r.minutes, 45);
  r = parseMeetCommand('2026-10-01 10:00 Planning', now);
  assert.equal(iso(r), '2026-10-01T03:00:00.000Z');
  assert.equal(parseMeetCommand('2026-09-01 10:00 Old', now).error, 'past');
  assert.equal(parseMeetCommand('lunch with Bob', now).error, 'time');
  assert.equal(parseMeetCommand('25:00 Bad', now).error, 'time');
});
