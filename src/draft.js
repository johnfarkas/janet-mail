// Builds a plain-text email and saves it to an account's Drafts folder.
// Drafts are never sent from here: the user reviews and sends them.

import { readMessage } from './mail.js';
import { folderMap } from './manage.js';

// senderName comes from settings.js (`name`); with none, the bare address is used.
export async function saveDraft(client, account, allAddresses, input, senderName = '') {
  const folders = await folderMap(client, account);
  if (!folders.drafts) throw new Error(`${account.label}: no Drafts folder found`);

  let { to, cc, bcc, subject, body } = input;
  const headers = {};
  let quoted = '';

  if (input.reply_to) {
    const orig = await readMessage(client, account, input.reply_to.folder, input.reply_to.uid, { maxChars: 4000 });
    const own = new Set(allAddresses.map((a) => a.toLowerCase()));
    const notMe = (list) =>
      splitAddresses(list).filter((a) => !own.has(addrOnly(a).toLowerCase()));
    if (!to) {
      const primary = notMe(orig.replyTo || orig.from);
      to = (primary.length ? primary : splitAddresses(orig.from)).join(', ');
      if (input.reply_all) {
        const others = [...notMe(orig.to), ...notMe(orig.cc)].filter((a) => !to.includes(addrOnly(a)));
        if (others.length) cc = [cc, others.join(', ')].filter(Boolean).join(', ');
      }
    }
    if (!subject) subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
    if (orig.messageId) {
      headers['In-Reply-To'] = orig.messageId;
      headers['References'] = [orig.references, orig.messageId].filter(Boolean).join(' ');
    }
    const when = orig.date ? new Date(orig.date).toUTCString() : 'earlier';
    quoted = `\n\nOn ${when}, ${orig.from} wrote:\n` + orig.body.split('\n').map((l) => `> ${l}`).join('\n');
  }

  if (!to && !input.allow_no_recipient) throw new Error('A draft needs "to" (or reply_to).');
  const message = buildMessage({
    from: senderName ? `${senderName} <${account.user}>` : account.user,
    to,
    cc,
    bcc,
    subject: subject || '',
    body: (body || '') + quoted,
    headers,
    domain: account.user.split('@')[1],
  });
  const uid = await client.appendDraft(folders.drafts, message);
  return { account: account.id, folder: folders.drafts, uid, from: account.user, to, cc, subject };
}

export function buildMessage({ from, to, cc, bcc, subject, body, headers = {}, domain = 'localhost', date = new Date() }) {
  const lines = [
    `From: ${from}`,
    to ? `To: ${to}` : null,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  for (const l of lines) if (/[\r\n]/.test(l)) throw new Error('Line breaks are not allowed in email headers');
  const b64 = base64Utf8(body.replace(/\r?\n/g, '\r\n'));
  return `${lines.join('\r\n')}\r\n\r\n${b64.match(/.{1,76}/g)?.join('\r\n') || ''}\r\n`;
}

function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64Utf8(s)}?=`;
}

function base64Utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function splitAddresses(list) {
  if (!list) return [];
  return String(list)
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function addrOnly(a) {
  const m = /<([^>]+)>/.exec(a);
  return (m ? m[1] : a).trim();
}
