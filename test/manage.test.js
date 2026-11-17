import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImapClient, copyUidMap, expandUidSet } from '../src/imap.js';
import { buildMessage, splitAddresses, addrOnly } from '../src/draft.js';
import { summarize } from '../src/manage.js';

const enc = new TextEncoder();

// Server that answers every tagged command OK, echoing an optional extra line.
function okSocket(extra = () => '') {
  const written = [];
  let controller;
  const readable = new ReadableStream({ start: (c) => (controller = c) });
  const writable = new WritableStream({
    write(chunk) {
      const text = new TextDecoder().decode(chunk);
      written.push(text);
      if (/\{\d+\}\r\n$/.test(text)) return controller.enqueue(enc.encode('+ go\r\n'));
      if (!text.endsWith('\r\n')) return;
      const tag = /^(A\d+) /.exec(written.join('').split('\r\n').filter(Boolean).pop() || '')?.[1] ||
        /^(A\d+) /.exec(written.slice().reverse().find((w) => /^A\d+ /.test(w)) || '')?.[1];
      controller.enqueue(enc.encode(`${extra(text)}${tag} OK done\r\n`));
    },
  });
  return { readable, writable, written, close: async () => {} };
}

test('uid sets and COPYUID parsing', () => {
  assert.deepEqual(expandUidSet('3,5:7'), [3, 5, 6, 7]);
  const m = copyUidMap(['OK [COPYUID 99 10:12,20 501:504] moved']);
  assert.equal(m.get(10), 501);
  assert.equal(m.get(20), 504);
});

test('move uses UID MOVE and reads the new UIDs', async () => {
  const sock = okSocket((t) => (t.includes('UID MOVE') ? '* OK [COPYUID 1 7,9 70:71]\r\n' : ''));
  const c = new ImapClient(sock);
  c.capabilities.add('MOVE');
  const map = await c.move([7, 9], 'Deleted Messages');
  assert.match(sock.written.join(''), /UID MOVE 7,9 "Deleted Messages"/);
  assert.equal(map.get(9), 71);
});

test('move without MOVE copies, flags and expunges only those UIDs', async () => {
  const sock = okSocket();
  const c = new ImapClient(sock);
  c.capabilities.add('UIDPLUS');
  await c.move([4, 5], 'Trash');
  const all = sock.written.join('');
  assert.match(all, /UID COPY 4,5 "Trash"/);
  assert.match(all, /UID STORE 4,5 \+FLAGS\.SILENT \(\\Deleted\)/);
  assert.match(all, /UID EXPUNGE 4,5/);
  assert.equal(c.expungeAllowedFor, null);
});

test('guards: no deleting, no expunge, no stray flags, drafts only to Drafts', async () => {
  const c = new ImapClient(okSocket());
  await assert.rejects(() => c.command('UID STORE', ['4', '+FLAGS', '(\\Deleted)']), /Blocked flag/);
  await assert.rejects(() => c.command('UID EXPUNGE', ['4']), /Blocked EXPUNGE/);
  await assert.rejects(() => c.command('EXPUNGE'), /Blocked/);
  await assert.rejects(() => c.command('DELETE', ['"INBOX"']), /Blocked/);
  await assert.rejects(() => c.command('UID STORE', ['1:*', '+FLAGS', '(\\Seen)']), /explicit UIDs/);
  await assert.rejects(() => c.command('UID STORE', ['4', 'FLAGS', '(\\Seen)']), /Blocked STORE/);
  await assert.rejects(() => c.command('APPEND', ['"INBOX"', '()', { literal: 'x' }]), /Drafts folder/);
  await c.storeFlags([4], true, ['\\Seen']);
  await c.storeLabels([4], false, ['\\Inbox']);
});

test('draft append goes to the named Drafts folder with the message as a literal', async () => {
  const sock = okSocket();
  const c = new ImapClient(sock);
  await c.appendDraft('[Gmail]/Drafts', 'Subject: hi\r\n\r\nbody\r\n');
  const all = sock.written.join('');
  assert.match(all, /APPEND "\[Gmail\]\/Drafts" \(\\Draft \\Seen\) \{\d+\}/);
  assert.match(all, /Subject: hi/);
  assert.equal(c.appendAllowedTo, null);
});

test('buildMessage makes a valid plain-text email with threading headers', () => {
  const msg = buildMessage({
    from: 'Pat Example <pat@x.com>',
    to: 'a@b.com',
    subject: 'Café plans',
    body: 'Hi there\nLine two',
    headers: { 'In-Reply-To': '<1@b.com>', References: '<0@b.com> <1@b.com>' },
    domain: 'x.com',
  });
  assert.match(msg, /^From: Pat Example <pat@x.com>\r\nTo: a@b.com\r\n/);
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  assert.match(msg, /In-Reply-To: <1@b.com>/);
  const b64 = msg.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Hi there\r\nLine two');
  assert.throws(() => buildMessage({ from: 'a', to: 'x\r\nBcc: evil', subject: '', body: '' }), /Line breaks/);
});

test('address helpers and batch summary', () => {
  assert.deepEqual(splitAddresses('"Doe, Jane" <j@d.com>, b@c.com'), ['"Doe, Jane" <j@d.com>', 'b@c.com']);
  assert.equal(addrOnly('Jane <j@d.com>'), 'j@d.com');
  const s = summarize([
    { account: 'gmail', from: 'LinkedIn <n@linkedin.com>', subject: 'a', date: '2026-03-01' },
    { account: 'gmail', from: 'LinkedIn <n@linkedin.com>', subject: 'b', date: '2026-11-01' },
    { account: 'icloud', from: 'x@y.com', subject: 'c', date: '2026-06-01' },
  ]);
  assert.equal(s.count, 3);
  assert.deepEqual(s.byAccount, { gmail: 2, icloud: 1 });
  assert.deepEqual(s.topSenders[0], { sender: 'n@linkedin.com', count: 2 });
  assert.equal(s.oldest, '2026-03-01');
});

import { senderMatches, ruleFor, normalizeSender, listInfo } from '../src/rules.js';

test('sender rules: exact address, whole domain with subdomains, keep beats block', () => {
  assert.equal(normalizeSender('Jane <Jane@Leads.io>'), 'jane@leads.io');
  assert.ok(senderMatches({ match: 'leads.io' }, 'x@mail.leads.io'));
  assert.ok(senderMatches({ match: 'leads.io' }, 'x@leads.io'));
  assert.ok(!senderMatches({ match: 'leads.io' }, 'x@notleads.io'));
  assert.ok(senderMatches({ match: 'a@b.com' }, 'A <a@b.com>'));
  assert.ok(!senderMatches({ match: 'a@b.com' }, 'c@b.com'));
  const rules = { block: [{ match: 'himss.org' }], keep: [{ match: 'news@himss.org', then: 'archive' }] };
  assert.equal(ruleFor(rules, 'news@himss.org').kind, 'keep');
  assert.equal(ruleFor(rules, 'promo@himss.org').kind, 'block');
  assert.equal(ruleFor(rules, 'x@y.com'), null);
});

test('list headers: one-click only with https + List-Unsubscribe-Post', async () => {
  const enc = new TextEncoder();
  const a = await listInfo(enc.encode('From: News <n@x.com>\r\nList-Unsubscribe: <mailto:u@x.com>, <https://x.com/u?id=1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nSubject: Hi\r\n'));
  assert.equal(a.oneClickUrl, 'https://x.com/u?id=1');
  assert.equal(a.isList, true);
  const b = await listInfo(enc.encode('From: n@x.com\r\nList-Unsubscribe: <https://x.com/u>\r\n'));
  assert.equal(b.oneClickUrl, null);
  const c = await listInfo(enc.encode('From: Bob <bob@agency.co>\r\nSubject: quick question\r\n'));
  assert.equal(c.isList, false);
});
