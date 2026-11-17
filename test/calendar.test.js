import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TZ, parseInput, toLocalIso, wallToDate, buildEvent, patchEvent, parseEvents, resolveTimes, fold, readIcsTime, vtimezone } from '../src/calendar.js';

// These tests work whatever time zone settings.js names: expectations are built
// from that zone, or use fixed zones passed in explicitly.
const local = (iso) => toLocalIso(parseInput(iso).date);
const tzRe = new RegExp(`DTSTART;TZID=${TZ.replace(/[/+]/g, '\\$&')}:20261112T140000`);

test('wall times cross DST correctly', () => {
  assert.equal(toLocalIso(wallToDate(2026, 11, 12, 14, 0, 0, 'America/Chicago'), 'America/Chicago'), '2026-11-12T14:00:00-06:00');
  assert.equal(toLocalIso(wallToDate(2026, 7, 4, 9, 30, 0, 'America/Chicago'), 'America/Chicago'), '2026-07-04T09:30:00-05:00');
  assert.equal(toLocalIso(wallToDate(2026, 7, 4, 9, 30, 0, 'Europe/Berlin'), 'Europe/Berlin'), '2026-07-04T09:30:00+02:00');
  assert.match(local('2026-11-12T14:00'), /^2026-11-12T14:00:00[+-]\d\d:\d\d$/);
  assert.match(local('2026-07-04T09:30'), /^2026-07-04T09:30:00[+-]\d\d:\d\d$/);
  assert.equal(parseInput('2026-11-12T20:00:00Z').date.toISOString(), '2026-11-12T20:00:00.000Z');
  assert.deepEqual(parseInput('2026-11-12'), { day: '2026-11-12' });
  assert.throws(() => parseInput('next tuesday'));
});

test('other time zones are read in their own zone', () => {
  const t = readIcsTime(';TZID=America/Denver', '20261112T140000');
  assert.equal(t.date.toISOString(), '2026-11-12T21:00:00.000Z');
  // A zone name Intl doesn't know is read in the user's own zone.
  const unknown = readIcsTime(';TZID=Some Unknown Zone', '20261112T140000');
  assert.equal(toLocalIso(unknown.date), local('2026-11-12T14:00'));
});

test('resolveTimes defaults and all-day ends', () => {
  const r = resolveTimes({ start: '2026-11-12T14:00' });
  assert.equal(r.end.date - r.start.date, 3600000);
  assert.deepEqual(resolveTimes({ start: '2026-11-12', end: '2026-11-14' }), { start: { day: '2026-11-12' }, end: { day: '2026-11-15' } });
  assert.throws(() => resolveTimes({ start: '2026-11-12T14:00', end: '2026-11-12T13:00' }));
});

test('build then read back', () => {
  const t = resolveTimes({ start: '2026-11-12T14:00', end: '2026-11-12T15:30' });
  const ics = buildEvent({ uid: 'ABC', title: 'Ride, then coffee; ok', ...t, location: 'Main Street', notes: 'line one\nline two' });
  assert.match(ics, tzRe);
  assert.match(ics, /BEGIN:VTIMEZONE/);
  const [e] = parseEvents(ics);
  assert.equal(e.title, 'Ride, then coffee; ok');
  assert.equal(e.start, local('2026-11-12T14:00'));
  assert.equal(e.end, local('2026-11-12T15:30'));
  assert.equal(e.notes, 'line one\nline two');
  assert.equal(e.all_day, false);
});

test('patch keeps alarms and other fields, bumps sequence', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:X', 'SEQUENCE:2', 'DTSTART:20261112T200000Z', 'DTEND:20261112T210000Z',
    'SUMMARY:Old', 'DESCRIPTION:keep me', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const t = resolveTimes({ start: '2026-11-13T09:00', end: '2026-11-13T10:00' });
  const out = patchEvent(ics, { title: 'New', ...t });
  assert.match(out, /SEQUENCE:3/);
  assert.match(out, /BEGIN:VALARM[\s\S]*DESCRIPTION:Reminder[\s\S]*END:VALARM/);
  assert.match(out, /DESCRIPTION:keep me/);
  assert.match(out, /X-APPLE-TRAVEL/);
  assert.match(out, /BEGIN:VTIMEZONE/);
  assert.equal((out.match(/END:VEVENT/g) || []).length, 1);
  const [e] = parseEvents(out);
  assert.equal(e.title, 'New');
  assert.equal(e.start, local('2026-11-13T09:00'));
  const cleared = patchEvent(ics, { notes: null });
  assert.doesNotMatch(cleared, /DESCRIPTION:keep me/);
  assert.match(cleared, /DESCRIPTION:Reminder/);
});

test('long lines fold at 75 octets', () => {
  const line = 'DESCRIPTION:' + 'é'.repeat(100);
  const folded = fold(line);
  for (const part of folded.split('\r\n')) assert.ok(new TextEncoder().encode(part).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), line);
});

test('VTIMEZONE blocks follow the real clock changes', () => {
  const ny = vtimezone('America/New_York', new Date('2026-11-12T12:00:00Z')).join('\n');
  assert.match(ny, /TZID:America\/New_York/);
  assert.match(ny, /BEGIN:STANDARD\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nTZNAME:EST\nDTSTART:20261101T020000/);
  assert.match(ny, /BEGIN:DAYLIGHT\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nTZNAME:EDT\nDTSTART:20260308T020000/);
  const az = vtimezone('America/Phoenix', new Date('2026-11-12T12:00:00Z')).join('\n');
  assert.match(az, /TZOFFSETFROM:-0700\nTZOFFSETTO:-0700/);
  assert.doesNotMatch(az, /DAYLIGHT/);
});
