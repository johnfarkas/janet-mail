import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImapClient, parseTokens, asString, decodeMutf7, encodeMutf7 } from '../src/imap.js';
import { buildCriteria, htmlToText } from '../src/mail.js';

const enc = new TextEncoder();

// A fake server: feeds scripted bytes and records what the client writes.
function fakeSocket(script) {
  const written = [];
  let step = 0;
  let controller;
  const readable = new ReadableStream({
    start(c) {
      controller = c;
      if (script[0]?.greet) controller.enqueue(enc.encode(script[step++].greet));
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      const text = new TextDecoder().decode(chunk);
      written.push(text);
      if (!text.endsWith('\r\n')) return;
      const next = script[step];
      if (next && next.reply) {
        step++;
        const reply = typeof next.reply === 'function' ? next.reply(text) : next.reply;
        controller.enqueue(typeof reply === 'string' ? enc.encode(reply) : reply);
      }
    },
  });
  return { readable, writable, written, close: async () => {} };
}

test('parses LIST lines with flags, delimiter and modified UTF-7 names', () => {
  const t = parseTokens(['* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"']);
  assert.equal(t[1], 'LIST');
  assert.deepEqual(t[2], ['\\HasNoChildren', '\\All']);
  assert.equal(asString(t[3]), '/');
  assert.equal(asString(t[4]), '[Gmail]/All Mail');
  assert.equal(decodeMutf7('Entw&APw-rfe'), 'Entwürfe');
  assert.equal(encodeMutf7('Entwürfe'), 'Entw&APw-rfe');
  assert.equal(decodeMutf7(encodeMutf7('A & B 日本')), 'A & B 日本');
});

test('parses FETCH with section atoms and literals', () => {
  const lit = enc.encode('From: a@b.c\r\nSubject: Hi\r\n\r\n');
  const t = parseTokens([
    '* 3 FETCH (UID 42 FLAGS (\\Seen) RFC822.SIZE 900 BODY[HEADER.FIELDS (FROM SUBJECT)] ',
    lit,
    ')',
  ]);
  const list = t[3];
  assert.equal(list[0], 'UID');
  assert.equal(list[1], '42');
  assert.deepEqual(list[3], ['\\Seen']);
  assert.equal(list[6], 'BODY[HEADER.FIELDS (FROM SUBJECT)]');
  assert.ok(list[7] instanceof Uint8Array);
});

test('client logs in, reads literals split across chunks, and refuses write commands', async () => {
  const body = 'Subject: Test\r\n\r\nhello';
  const sock = fakeSocket([
    { greet: '* OK ready\r\n' },
    { reply: 'A1 OK logged in\r\n' },
    { reply: '* CAPABILITY IMAP4rev1 X-GM-EXT-1\r\nA2 OK\r\n' },
    { reply: '* 1 EXISTS\r\nA3 OK [READ-ONLY] done\r\n' },
    {
      reply: enc.encode(`* 1 FETCH (UID 7 BODY[] {${enc.encode(body).length}}\r\n${body})\r\nA4 OK\r\n`),
    },
  ]);
  const c = new ImapClient(sock);
  await c.greet();
  await c.login('me@x.com', 'p"w');
  assert.ok(c.capabilities.has('X-GM-EXT-1'));
  assert.match(sock.written[0], /^A1 LOGIN "me@x.com" "p\\"w"\r\n$/);
  await c.examine('INBOX');
  assert.match(sock.written[1 + 1], /^A3 EXAMINE "INBOX"/);
  const r = await c.uidFetch([7], 'UID BODY.PEEK[]');
  assert.equal(new TextDecoder().decode(r.get(7)['BODY[]']), body);

  await assert.rejects(() => c.command('STORE', ['1', '+FLAGS', '(\\Seen)']), /Blocked/);
  await assert.rejects(() => c.command('EXPUNGE'), /Blocked/);
  await assert.rejects(() => c.uidFetch([7], 'BODY[]'), /BODY\.PEEK/);
  await assert.rejects(() => c.uidFetch([7], 'RFC822'), /BODY\.PEEK/);
});

test('non-ASCII search terms go as literals with CHARSET UTF-8', async () => {
  const sock = fakeSocket([
    { greet: '* OK\r\n' },
    { reply: '+ go ahead\r\n' },
    { reply: '* SEARCH 3 9 4\r\nA1 OK\r\n' },
  ]);
  const c = new ImapClient(sock);
  await c.greet();
  const { criteria, utf8 } = buildCriteria({ subject: 'café' }, { gmail: false });
  const uids = await c.uidSearch(criteria, { utf8 });
  assert.deepEqual(uids, [3, 9, 4]);
  assert.equal(sock.written[0], `A1 UID SEARCH CHARSET UTF-8 SUBJECT {5}\r\n`);
});

test('criteria: Gmail query, dates, unread', () => {
  const g = buildCriteria({ gmailQuery: 'from:bank has:attachment', since: '2026-10-01', unread: true }, { gmail: true });
  assert.deepEqual(g.criteria, ['X-GM-RAW', '"from:bank has:attachment"', 'SINCE', '1-Oct-2026', 'UNSEEN']);
  assert.throws(() => buildCriteria({ gmailQuery: 'from:x' }, { gmail: false }), /Gmail accounts/);
  assert.throws(() => buildCriteria({ since: 'last week' }, {}), /YYYY-MM-DD/);
});

test('html to text keeps links and line breaks', () => {
  const t = htmlToText('<style>x</style><p>Hi&nbsp;there</p><a href="https://x.y">link</a><br>bye');
  assert.equal(t, 'Hi there\nlink (https://x.y)\nbye');
});
