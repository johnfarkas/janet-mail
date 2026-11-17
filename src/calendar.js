// The user's iCloud calendar over CalDAV, signed in with the same app-specific
// password as iCloud mail (the secret named in settings.calendar.secret). Only the
// calendars named in settings.calendar.calendarNames are visible: the account may
// also hold calendars shared by other people, which stay out of reach.
//
// Times: a time given without an offset is read in settings.timeZone, and new or
// moved events are written with that time zone.

import SETTINGS from '../settings.js';

const ROOT = 'https://caldav.icloud.com';
export const TZ = SETTINGS.timeZone || 'UTC';

// ---- time helpers (pure) ---------------------------------------------------------

const formatters = new Map();
function parts(date, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

// Offset of `tz` from UTC at `date`, in minutes (New York in winter: -300).
export function offsetMinutes(date, tz = TZ) {
  const p = parts(date, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// Wall-clock time in `tz` -> the real instant.
export function wallToDate(y, mo, d, h = 0, mi = 0, s = 0, tz = TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  t = guess - offsetMinutes(new Date(t), tz) * 60000; // settle across a DST change
  return new Date(t);
}

// An instant -> "2026-11-12T14:00:00-05:00" in the user's time zone.
export function toLocalIso(date, tz = TZ) {
  const p = parts(date, tz);
  const off = offsetMinutes(date, tz);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Tool input -> { date } or { day: 'YYYY-MM-DD' }. "2026-11-12" is a day,
// "2026-11-12T14:00" is local time in TZ, anything with Z or an offset is exact.
export function parseInput(value) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { day: v };
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return { date: wallToDate(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)) };
  const d = new Date(v);
  if (!Number.isNaN(d.getTime()) && /[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) return { date: d };
  throw new Error(`Couldn't read the time "${value}". Use 2026-11-12 for a day or 2026-11-12T14:00 for a local time.`);
}

const ymd = (day) => day.replace(/-/g, '');
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const icsUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function icsWall(date) {
  const p = parts(date, TZ);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

// ---- ICS reading and writing (pure) ------------------------------------------------

// A VTIMEZONE block for any zone, built from the clock changes Intl knows about
// in the year before through the year after `around`. Calendar apps recognise the
// zone by its name (TZID); this block spells out the offsets as RFC 5545 asks.
const fmtOffset = (m) => {
  const a = Math.abs(m);
  return `${m < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
};
function zoneAbbr(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || null;
  } catch {
    return null;
  }
}
export function vtimezone(tz = TZ, around = new Date()) {
  const year = around.getUTCFullYear();
  const DAY = 86400000;
  const changes = [];
  let t = Date.UTC(year - 1, 0, 1, 12);
  const stop = Date.UTC(year + 2, 0, 1, 12);
  let off = offsetMinutes(new Date(t), tz);
  for (; t < stop; t += DAY) {
    const next = offsetMinutes(new Date(t + DAY), tz);
    if (next === off) continue;
    let lo = t;
    let hi = t + DAY; // the change happens in (lo, hi]: narrow it to the minute
    while (hi - lo > 60000) {
      const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
      if (offsetMinutes(new Date(mid), tz) === off) lo = mid;
      else hi = mid;
    }
    changes.push({ at: hi, from: off, to: next });
    off = next;
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (!changes.length) {
    const name = zoneAbbr(around, tz);
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${fmtOffset(off)}`, `TZOFFSETTO:${fmtOffset(off)}`,
      ...(name ? [`TZNAME:${name}`] : []), 'DTSTART:19700101T000000', 'END:STANDARD');
  }
  for (const c of changes) {
    const kind = c.to > c.from ? 'DAYLIGHT' : 'STANDARD';
    const wall = new Date(c.at + c.from * 60000).toISOString().replace(/[-:]/g, '').slice(0, 15);
    const name = zoneAbbr(new Date(c.at + 60000), tz);
    lines.push(`BEGIN:${kind}`, `TZOFFSETFROM:${fmtOffset(c.from)}`, `TZOFFSETTO:${fmtOffset(c.to)}`,
      ...(name ? [`TZNAME:${name}`] : []), `DTSTART:${wall}`, `END:${kind}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

export const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const unescapeText = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// Fold lines longer than 75 octets, as RFC 5545 asks.
export function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let limit = 75;
  for (const ch of line) {
    if (enc.encode(cur + ch).length > limit) {
      out.push(cur);
      cur = '';
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const unfold = (ics) => ics.replace(/\r?\n[ \t]/g, '');

function dtProp(name, at) {
  if (at.day) return `${name};VALUE=DATE:${ymd(at.day)}`;
  return `${name};TZID=${TZ}:${icsWall(at.date)}`;
}

// ICS date/time (with its parameters) -> { date } or { day }.
export function readIcsTime(params, value) {
  if (/VALUE=DATE(?!-)/.test(params || '') || /^\d{8}$/.test(value)) {
    return { day: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  if (m[7] === 'Z') return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) };
  let tz = (params || '').match(/TZID=("?)([^;:"]+)\1/)?.[2] || TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = TZ; // a zone name Intl doesn't know (some Outlook invites): read it in the user's zone
  }
  return { date: wallToDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], tz) };
}

function props(block) {
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    (out[m[1]] ||= []).push({ params: m[2], value: m[3] });
  }
  return out;
}

const shown = (t) => (t.day ? t.day : toLocalIso(t.date));

// All VEVENTs in an ICS body, as plain objects.
export function parseEvents(ics) {
  const events = [];
  for (const chunk of unfold(ics).split('BEGIN:VEVENT').slice(1)) {
    const p = props(chunk.split('END:VEVENT')[0]);
    const one = (k) => p[k]?.[0];
    if (!one('DTSTART')) continue;
    const start = readIcsTime(one('DTSTART').params, one('DTSTART').value);
    if (!start) continue;
    let end = one('DTEND') ? readIcsTime(one('DTEND').params, one('DTEND').value) : null;
    if (!end) end = start.day ? { day: addDays(start.day, 1) } : start;
    events.push({
      uid: one('UID')?.value || null,
      title: one('SUMMARY') ? unescapeText(one('SUMMARY').value) : 'Untitled',
      start: shown(start),
      end: shown(end),
      all_day: Boolean(start.day),
      location: one('LOCATION') ? unescapeText(one('LOCATION').value) || null : null,
      notes: one('DESCRIPTION') ? unescapeText(one('DESCRIPTION').value).slice(0, 1500) || null : null,
      url: one('URL')?.value || null,
      status: one('STATUS')?.value || null,
      repeats: Boolean(one('RRULE')) || Boolean(one('RECURRENCE-ID')),
      invite: Boolean(p.ATTENDEE?.length),
      organizer: one('ORGANIZER')?.value?.replace(/^mailto:/i, '') || null,
      _start: start,
      _end: end,
    });
  }
  return events;
}

export function buildEvent({ uid, title, start, end, location, notes }) {
  const now = icsUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//janet-mail//calendar//EN', 'CALSCALE:GREGORIAN',
    ...(start.day ? [] : vtimezone(TZ, start.date)),
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${now}`, `CREATED:${now}`, `LAST-MODIFIED:${now}`, 'SEQUENCE:0',
    dtProp('DTSTART', start), dtProp('DTEND', end),
    `SUMMARY:${escapeText(title)}`,
    ...(location ? [`LOCATION:${escapeText(location)}`] : []),
    ...(notes ? [`DESCRIPTION:${escapeText(notes)}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// Rewrite the master VEVENT of an existing ICS with new values. `change` holds
// title, location, notes (null clears), start/end as { date } or { day }.
export function patchEvent(ics, change) {
  const text = unfold(ics);
  const lines = text.split(/\r?\n/);
  const out = [];
  let inEvent = false;
  let master = false;
  let done = false;
  const hasTz = text.split(/\r?\n/).includes(`TZID:${TZ}`);
  let seq = 0;
  let pending = [];
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      pending = [line];
      continue;
    }
    if (!inEvent) {
      out.push(line);
      continue;
    }
    if (line !== 'END:VEVENT') {
      pending.push(line);
      continue;
    }
    pending.push(line);
    inEvent = false;
    master = !pending.some((l) => l.startsWith('RECURRENCE-ID'));
    if (!master || done) {
      out.push(...pending);
      continue;
    }
    done = true;
    const kept = [];
    let depth = 0; // inside a nested component (VALARM): leave its lines alone
    for (const l of pending.slice(1, -1)) {
      if (l.startsWith('BEGIN:')) depth++;
      if (depth > 0) {
        kept.push(l);
        if (l.startsWith('END:')) depth--;
        continue;
      }
      const name = l.match(/^([A-Z-]+)/)?.[1];
      if (name === 'SEQUENCE') seq = (parseInt(l.split(':')[1], 10) || 0) + 1;
      if (['SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED'].includes(name)) continue;
      if (name === 'SUMMARY' && change.title != null) continue;
      if (name === 'LOCATION' && change.location !== undefined) continue;
      if (name === 'DESCRIPTION' && change.notes !== undefined) continue;
      if ((name === 'DTSTART' || name === 'DTEND' || name === 'DURATION') && change.start) continue;
      kept.push(l);
    }
    kept.unshift('BEGIN:VEVENT');
    const now = icsUtc(new Date());
    kept.push(`DTSTAMP:${now}`, `LAST-MODIFIED:${now}`, `SEQUENCE:${seq}`);
    if (change.title != null) kept.push(`SUMMARY:${escapeText(change.title)}`);
    if (change.location) kept.push(`LOCATION:${escapeText(change.location)}`);
    if (change.notes) kept.push(`DESCRIPTION:${escapeText(change.notes)}`);
    if (change.start) kept.push(dtProp('DTSTART', change.start), dtProp('DTEND', change.end));
    kept.push('END:VEVENT');
    out.push(...kept);
  }
  if (!done) throw new Error('That calendar entry has no event in it.');
  let result = out.filter((l, i) => l !== '' || i < out.length - 1);
  if (change.start && !change.start.day && !hasTz) {
    const at = result.indexOf('BEGIN:VEVENT');
    result.splice(at, 0, ...vtimezone(TZ, change.start.date));
  }
  return result.map(fold).join('\r\n') + '\r\n';
}

// ---- CalDAV ------------------------------------------------------------------------

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#13;/g, '\r').replace(/&#10;/g, '\n').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const first = (xml, tag) => {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`));
  return m ? m[1] : null;
};

function user() {
  return SETTINGS.calendar?.user || '';
}

async function dav(env, url, method, { depth, body, headers = {} } = {}) {
  const password = (env[SETTINGS.calendar?.secret || 'ICLOUD_APP_PASSWORD'] || '').replace(/\s+/g, '');
  if (!password) throw new Error('The iCloud password is not set up on this connector.');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${user()}:${password}`)}`,
      'User-Agent': 'janet-mail calendar',
      ...(depth != null ? { Depth: String(depth) } : {}),
      ...(body && !headers['Content-Type'] ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
      ...headers,
    },
    body,
  });
  if (res.status === 401) throw new Error('iCloud refused the calendar password.');
  return res;
}

async function davText(env, url, method, opts) {
  const res = await dav(env, url, method, opts);
  if (!res.ok && res.status !== 207) throw new Error(`iCloud calendar answered ${res.status} to ${method}.`);
  return res.text();
}

const allowed = () =>
  (SETTINGS.calendar?.calendarNames || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);

const memo = new Map(); // isolate-level cache of the calendar list (an hour)

// The calendars this connector may use: [{ name, url }].
export async function calendars(env, { all = false } = {}) {
  const key = user();
  const hit = memo.get(key);
  let list = hit && hit.at > Date.now() - 3600000 ? hit.list : null;
  if (!list) {
    const p1 = await davText(env, `${ROOT}/`, 'PROPFIND', { depth: 0, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>' });
    const principal = first(first(p1, 'current-user-principal') || '', 'href');
    if (!principal) throw new Error('iCloud: no calendar account found.');
    const p2 = await davText(env, new URL(principal.trim(), ROOT).toString(), 'PROPFIND', {
      depth: 0,
      body: '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>',
    });
    const home = first(first(p2, 'calendar-home-set') || '', 'href');
    if (!home) throw new Error('iCloud: no calendar home found.');
    const homeUrl = new URL(decode(home).trim(), ROOT).toString();
    const p3 = await davText(env, homeUrl, 'PROPFIND', {
      depth: 1,
      body: '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>',
    });
    list = [];
    for (const resp of p3.split(/<(?:[\w-]+:)?response\b/).slice(1)) {
      const type = first(resp, 'resourcetype') || '';
      if (!/calendar/.test(type)) continue;
      const comps = first(resp, 'supported-calendar-component-set') || '';
      if (comps && !/VEVENT/.test(comps)) continue; // reminders lists
      list.push({
        name: decode(first(resp, 'displayname') || '').trim(),
        url: new URL(decode(first(resp, 'href')).trim(), homeUrl).toString(),
        shared: /shared(?!-owner)/.test(type),
      });
    }
    memo.set(key, { at: Date.now(), list });
  }
  if (all) return list;
  const names = allowed();
  return list.filter((c) => names.includes(c.name.toLowerCase()));
}

async function calendarNamed(env, name) {
  const mine = await calendars(env);
  if (!mine.length) throw new Error(`No calendar named ${allowed().join(' or ')} on this iCloud account.`);
  if (!name) return mine[0];
  const c = mine.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!c) throw new Error(`Calendar "${name}" isn't one this connector can use. Use: ${mine.map((x) => x.name).join(', ')}.`);
  return c;
}

const idOf = (href) => decodeURIComponent(href.replace(/\/+$/, '').split('/').pop());

function checkId(id) {
  if (!/^[\w@.+=%-]{1,200}\.ics$/i.test(id)) throw new Error('That id doesn\'t look like a calendar event id (it ends in .ics).');
  return id;
}

// Events overlapping [from, to), recurring ones expanded into their instances.
export async function listEvents(env, { from, to, text, calendar }) {
  const cals = calendar ? [await calendarNamed(env, calendar)] : await calendars(env);
  const range = `start="${icsUtc(from)}" end="${icsUtc(to)}"`;
  const out = [];
  for (const cal of cals) {
    const xml = await davText(env, cal.url, 'REPORT', {
      depth: 1,
      body: `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop><d:getetag/><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>
        <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter>
      </c:calendar-query>`,
    });
    for (const resp of xml.split(/<(?:[\w-]+:)?response\b/).slice(1)) {
      const href = first(resp, 'href');
      const data = first(resp, 'calendar-data');
      if (!href || !data) continue;
      for (const e of parseEvents(decode(data))) {
        if (e.status === 'CANCELLED') continue;
        const s = e._start.day ? wallToDate(...e._start.day.split('-').map(Number)) : e._start.date;
        const en = e._end.day ? wallToDate(...e._end.day.split('-').map(Number)) : e._end.date;
        if (!(en > from && s < to) && !(s >= from && s < to)) continue;
        out.push({ id: idOf(decode(href).trim()), calendar: cal.name, ...e });
      }
    }
  }
  const q = text?.toLowerCase();
  return out
    .filter((e) => !q || [e.title, e.location, e.notes].some((v) => v?.toLowerCase().includes(q)))
    .sort((a, b) => (a._start.day ? wallToDate(...a._start.day.split('-').map(Number)) : a._start.date) - (b._start.day ? wallToDate(...b._start.day.split('-').map(Number)) : b._start.date))
    .map(({ _start, _end, ...e }) => e);
}

// One event resource as stored: { ics, etag, url, calendar }.
export async function getEvent(env, id, calendar) {
  checkId(id);
  const cals = calendar ? [await calendarNamed(env, calendar)] : await calendars(env);
  for (const cal of cals) {
    const url = new URL(encodeURIComponent(id), cal.url).toString();
    const res = await dav(env, url, 'GET');
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`iCloud calendar answered ${res.status} reading that event.`);
    const ics = await res.text();
    // iCloud's GET ETag header doesn't always match what If-Match expects; the
    // DAV getetag property does.
    const prop = await davText(env, url, 'PROPFIND', { depth: 0, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>' });
    const etag = decode(first(prop, 'getetag') || '').trim() || res.headers.get('ETag');
    return { ics, etag, url, calendar: cal.name };
  }
  throw new Error('No event with that id on the user\'s calendar. Look it up again with calendar_events.');
}

export async function putEvent(env, url, ics, { etag, create } = {}) {
  const res = await dav(env, url, 'PUT', {
    body: ics,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      ...(create ? { 'If-None-Match': '*' } : {}),
      ...(etag ? { 'If-Match': etag } : {}),
    },
  });
  if (res.status === 412) throw new Error('The event changed on iCloud since it was read. Read it again and retry.');
  if (!res.ok) throw new Error(`iCloud calendar answered ${res.status} saving the event: ${(await res.text()).slice(0, 200)}`);
}

export async function deleteEvent(env, url, etag) {
  const res = await dav(env, url, 'DELETE', { headers: etag ? { 'If-Match': etag } : {} });
  if (res.status === 412) throw new Error('The event changed on iCloud since it was read. Read it again and retry.');
  if (!res.ok && res.status !== 404) throw new Error(`iCloud calendar answered ${res.status} deleting the event.`);
}

export async function createEvent(env, { calendar, title, start, end, location, notes }) {
  const cal = await calendarNamed(env, calendar);
  const uid = `${crypto.randomUUID()}`.toUpperCase();
  const id = `${uid}.ics`;
  const ics = buildEvent({ uid, title, start, end, location, notes });
  const url = new URL(id, cal.url).toString();
  await putEvent(env, url, ics, { create: true });
  return { id, calendar: cal.name, url, ics };
}

// Resolve start/end inputs into { start, end } as { date } or { day }.
export function resolveTimes({ start, end, all_day }) {
  const s = parseInput(start);
  if (all_day || s.day) {
    const day = s.day || toLocalIso(s.date).slice(0, 10);
    let last = end ? parseInput(end) : null;
    const lastDay = last ? last.day || toLocalIso(last.date).slice(0, 10) : day;
    if (lastDay < day) throw new Error('The end is before the start.');
    // ICS all-day ends are exclusive: the day after the last day.
    return { start: { day }, end: { day: addDays(lastDay, 1) } };
  }
  const e = end ? parseInput(end) : { date: new Date(s.date.getTime() + 3600000) };
  if (e.day) throw new Error('Give the end as a time too (2026-11-12T15:00), or set all_day.');
  if (e.date <= s.date) throw new Error('The end is before the start.');
  return { start: s, end: e };
}
