#!/usr/bin/env node
// Local check of one mailbox before deploying. Asks for the app password
// (hidden, never saved), then lists folders, shows the 5 newest messages,
// and opens the newest one. Nothing in the mailbox changes.
//
//   node scripts/try.mjs <mailbox id from settings.js>

import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { ACCOUNTS } from '../src/accounts.js';
import { withAccount, listFolders, defaultFolders, search, readMessage } from '../src/mail.js';

const id = process.argv[2];
const account = ACCOUNTS.find((a) => a.id === id);
if (!account) {
  console.error(`Usage: node scripts/try.mjs ${ACCOUNTS.map((a) => a.id).join(' | ')}`);
  process.exit(1);
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    stdin.on('data', function onData(buf) {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}

function openSocket(host, port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host }, () => {
      const { readable, writable } = Duplex.toWeb(s);
      resolve({ readable, writable, close: async () => s.destroy() });
    });
    s.once('error', reject);
  });
}

const password = (process.env.MAIL_PW ?? (await askHidden(`App password for ${account.user}: `))).replace(/\s+/g, '');
const started = Date.now();
try {
await withAccount({ ...account, password }, openSocket, async (client) => {
  console.log(`✓ Signed in to ${account.label}`);
  const folders = await listFolders(client);
  console.log(`✓ ${folders.length} folders: ${folders.map((f) => f.name + (f.role ? ` [${f.role}]` : '')).join(', ')}`);
  const where = await defaultFolders(client, account);
  console.log(`✓ Default search folders: ${where.join(', ')}`);
  const hits = await search(client, account, where, {}, { limit: 5 });
  console.log(`✓ Newest ${hits.length} messages:`);
  for (const h of hits) console.log(`   ${h.date?.slice(0, 10)}  ${h.from}  —  ${h.subject}${h.unread ? '  (unread)' : ''}`);
  if (hits[0]) {
    const msg = await readMessage(client, account, hits[0].folder, hits[0].uid);
    console.log(`✓ Opened the newest: ${msg.body.length} characters of text, ${msg.attachments.length} attachments, still ${msg.unread ? 'unread' : 'read'}`);
  }
});
} catch (e) {
  console.error(`✗ ${e?.message || e}`);
  process.exit(1);
}
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Nothing was changed in the mailbox.`);
