// Reads Outlook calendar events and formats them for LINE. No AI involved.
import { config } from './config.js';
import { graphGet, graphRequest } from './microsoft.js';

// Graph returns times like "2026-09-28T09:00:00.0000000" in the zone we ask for (UTC).
const parseUtc = (dateTime) => new Date(`${dateTime.slice(0, 19)}Z`);

// Events (including each occurrence of recurring meetings) that overlap `from`–`to`.
export async function fetchEvents(from, to) {
  const query = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: 'id,subject,start,end,location,isAllDay,isCancelled,responseStatus,onlineMeeting',
    $orderby: 'start/dateTime',
    $top: '200',
  });
  const body = await graphGet(`/me/calendarView?${query}`, { Prefer: 'outlook.timezone="UTC"' });

  return body.value
    .filter((e) => !e.isCancelled && e.responseStatus?.response !== 'declined')
    .map((e) => ({
      id: e.id,
      subject: e.subject || '(no title)',
      start: parseUtc(e.start.dateTime),
      end: parseUtc(e.end.dateTime),
      isAllDay: e.isAllDay,
      location: e.location?.displayName || '',
      joinUrl: e.onlineMeeting?.joinUrl || '',
    }));
}

export const alertKey = (event) => `${event.id}|${event.start.toISOString()}`;

// Timed meetings starting within the next `leadMinutes` that haven't been alerted yet.
export function dueForAlert(events, now, alreadyAlerted, leadMinutes = config.calendar.leadMinutes) {
  const cutoff = now.getTime() + leadMinutes * 60 * 1000;
  return events.filter(
    (e) => !e.isAllDay && e.start > now && e.start.getTime() <= cutoff && !alreadyAlerted.has(alertKey(e)),
  );
}

const time = (date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: config.calendar.timezone, hour: '2-digit', minute: '2-digit' }).format(date);

function describe(event, finished = false) {
  const lines = [finished ? `✔️ ${event.subject} (finished)` : `📅 ${event.subject}`, `🕐 ${time(event.start)}–${time(event.end)}`];
  if (event.location) lines.push(`📍 ${event.location}`);
  if (event.joinUrl) lines.push(`🔗 ${event.joinUrl}`);
  return lines.join('\n');
}

function startsIn(event, now) {
  const minutes = Math.round((event.start - now) / 60000);
  return minutes >= 55 ? 'in 1 hour' : `in ${minutes} min`;
}

export function formatAlert(events, now) {
  const header = events.length === 1
    ? `⏰ Meeting ${startsIn(events[0], now)}`
    : `⏰ ${events.length} meetings coming up`;
  return [header, ...events.map((e) => (events.length === 1 ? describe(e) : `${describe(e)}\n(${startsIn(e, now)})`))].join('\n\n');
}

// The periods /calendar can show: today, tomorrow, or this week (Monday to Sunday).
export const AGENDA_RANGES = {
  today: { title: 'Today', empty: '📅 No meetings today.', from: (now) => startOfDay(now), to: (now) => startOfDay(now, 1) },
  tomorrow: { title: 'Tomorrow', empty: '📅 No meetings tomorrow.', from: (now) => startOfDay(now, 1), to: (now) => startOfDay(now, 2) },
  week: { title: 'This week', empty: '📅 No meetings this week.', from: (now) => startOfWeek(now), to: (now) => startOfWeek(now, 7) },
};

// Reads "today", "tomorrow" or "week" (and a few short forms). Empty means today; unknown gives null.
export function parseAgendaRange(arg) {
  const word = arg.trim().toLowerCase();
  if (['', 'today', 'วันนี้'].includes(word)) return 'today';
  if (['tomorrow', 'tmr', 'พรุ่งนี้'].includes(word)) return 'tomorrow';
  if (['week', '7', '7d', 'next7', 'สัปดาห์'].includes(word)) return 'week';
  return null;
}

const dayLabel = (date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: config.calendar.timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(date);

// LINE allows 5,000 characters per message; keep room for the "more" note.
const AGENDA_MAX_CHARS = 4700;

export function formatAgenda(events, now, range = 'today') {
  const { title, empty, from } = AGENDA_RANGES[range];
  const start = from(now);
  // Finished meetings are listed too, marked ✔️.
  const shown = events;
  if (shown.length === 0) return empty;

  // Group by the day each event starts on (events already under way count from the start of the period).
  const days = new Map();
  for (const e of shown) {
    const label = dayLabel(e.start > start ? e.start : start);
    if (!days.has(label)) days.set(label, { allDay: [], timed: [] });
    days.get(label)[e.isAllDay ? 'allDay' : 'timed'].push(e);
  }

  const headers = {
    today: `📅 Today, ${dayLabel(start)} (${shown.length})`,
    tomorrow: `📅 Tomorrow, ${dayLabel(start)} (${shown.length})`,
    week: `📅 This week, ${dayLabel(start)} – ${dayLabel(startOfWeek(now, 6))} (${shown.length})`,
  };
  const header = headers[range] ?? `📅 ${title} (${shown.length})`;
  const parts = [header];
  for (const [label, { allDay, timed }] of days) {
    if (range === 'week') parts.push(`━━ ${label} ━━`);
    if (allDay.length) parts.push(allDay.map((e) => `🗓 All day: ${e.subject}`).join('\n'));
    parts.push(...timed.map((e) => describe(e, e.end <= now)));
  }

  let text = '';
  for (let i = 0; i < parts.length; i++) {
    const next = text ? `${text}\n\n${parts[i]}` : parts[i];
    if (next.length > AGENDA_MAX_CHARS) return `${text}\n\n…and more. Open Outlook to see everything.`;
    text = next;
  }
  return text;
}

// The calendar time zone's wall-clock date and UTC offset at `date`.
function zoned(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.calendar.timezone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, Number(p.value)]),
  );
  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return { ...parts, offsetMs: wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000 };
}

// Midnight at the start of the day `days` from today, in the calendar's time zone.
export function startOfDay(now, days = 0) {
  const { year, month, day } = zoned(now);
  return zonedToUtc(year, month, day + days, 0, 0);
}

// Midnight at the start of this week's Monday (plus `days`), in the calendar's time zone.
export function startOfWeek(now, days = 0) {
  const { year, month, day } = zoned(now);
  const sinceMonday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return zonedToUtc(year, month, day - sinceMonday + days, 0, 0);
}

// Midnight tonight in the calendar's time zone.
export function endOfToday(now) {
  const { year, month, day, offsetMs } = zoned(now);
  return new Date(Date.UTC(year, month - 1, day + 1) - offsetMs);
}

// Midnight this morning in the calendar's time zone.
export function startOfToday(now) {
  const { year, month, day, offsetMs } = zoned(now);
  return new Date(Date.UTC(year, month - 1, day) - offsetMs);
}

// Converts a wall-clock time in the calendar's time zone to a Date.
function zonedToUtc(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess - zoned(new Date(guess)).offsetMs);
}

const DEFAULT_MEETING_MINUTES = 30;

// Parses "/meet" arguments. Returns { start, minutes, subject } or { error }.
//   in 30 Title | 14:30 Title | tomorrow 9:00 Title | 2026-10-01 10:00 Title
// An optional length like "60m" or "1h" may follow the time.
export function parseMeetCommand(arg, now) {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const today = zoned(now);
  let start;

  const clock = (text) => {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(text ?? '');
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return { hour: Number(m[1]), minute: Number(m[2]) };
  };

  if (tokens[0]?.toLowerCase() === 'in' && /^\d+$/.test(tokens[1] ?? '')) {
    start = new Date(now.getTime() + Number(tokens[1]) * 60000);
    tokens.splice(0, 2);
  } else if (tokens[0]?.toLowerCase() === 'tomorrow' && clock(tokens[1])) {
    const { hour, minute } = clock(tokens[1]);
    start = zonedToUtc(today.year, today.month, today.day + 1, hour, minute);
    tokens.splice(0, 2);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[0] ?? '') && clock(tokens[1])) {
    const [year, month, day] = tokens[0].split('-').map(Number);
    const { hour, minute } = clock(tokens[1]);
    start = zonedToUtc(year, month, day, hour, minute);
    tokens.splice(0, 2);
  } else if (clock(tokens[0])) {
    const { hour, minute } = clock(tokens[0]);
    start = zonedToUtc(today.year, today.month, today.day, hour, minute);
    if (start <= now) start = zonedToUtc(today.year, today.month, today.day + 1, hour, minute);
    tokens.splice(0, 1);
  } else {
    return { error: 'time' };
  }

  if (Number.isNaN(start.getTime())) return { error: 'time' };
  if (start <= now) return { error: 'past' };

  let minutes = DEFAULT_MEETING_MINUTES;
  const length = /^(\d+)(m|min|h)$/i.exec(tokens[0] ?? '');
  if (length) {
    minutes = Number(length[1]) * (length[2].toLowerCase() === 'h' ? 60 : 1);
    tokens.shift();
  }
  if (minutes < 1 || minutes > 24 * 60) return { error: 'length' };

  return { start, minutes, subject: tokens.join(' ').slice(0, 200) || 'Test meeting' };
}

export async function createEvent({ start, minutes, subject }) {
  const end = new Date(start.getTime() + minutes * 60000);
  const utc = (date) => ({ dateTime: date.toISOString().slice(0, 19), timeZone: 'UTC' });
  const created = await graphRequest('POST', '/me/events', {
    body: { subject, start: utc(start), end: utc(end), body: { contentType: 'text', content: 'Created from LINE' } },
  });
  return { id: created.id, subject, start, end, isAllDay: false, location: '', joinUrl: '' };
}

export async function deleteEvent(id) {
  await graphRequest('DELETE', `/me/events/${encodeURIComponent(id)}`);
}

export function formatDateTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.calendar.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
