// Mail tools built on the read-only IMAP client: list folders, search,
// read one message. Works the same in the Worker and in the local test script;
// only the socket opener differs.

import PostalMime from 'postal-mime';
import { ImapClient, asBytes, asString, textArg } from './imap.js';

const HEADER_FIELDS = 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]';
const MAX_FULL_BYTES = 4 * 1024 * 1024; // read at most 4 MB of one message
const PREVIEW_BYTES = 6 * 1024;

// accounts: [{ id, label, host, port, user, password, gmail }]
export async function withAccount(account, openSocket, fn) {
  if (!account.password) throw new Error(`${account.label} is not set up yet: its app password has not been stored.`);
  const socket = await openSocket(account.host, account.port || 993);
  const client = new ImapClient(socket);
  try {
    await client.greet();
    await client.login(account.user, account.password);
    return await fn(client);
  } finally {
    await client.logout();
  }
}

export async function listFolders(client) {
  const folders = await client.list();
  return folders
    .filter((f) => !f.flags.some((x) => /\\Noselect|\\NonExistent/i.test(x)))
    .map((f) => ({ name: f.name, role: roleOf(f) }));
}

function roleOf(folder) {
  const flags = folder.flags.map((x) => x.toLowerCase());
  for (const role of ['all', 'archive', 'sent', 'drafts', 'junk', 'trash', 'flagged', 'important']) {
    if (flags.includes(`\\${role}`)) return role;
  }
  if (folder.name.toUpperCase() === 'INBOX') return 'inbox';
  return null;
}

// Which folders a search looks in when the caller names none.
// Gmail: All Mail holds everything except spam and trash.
// Others: inbox, archive and sent.
export async function defaultFolders(client, account) {
  const folders = await listFolders(client);
  const byRole = (r) => folders.find((f) => f.role === r)?.name;
  if (account.gmail) return [byRole('all') || '[Gmail]/All Mail'];
  const archive = byRole('archive') || folders.find((f) => /^archive$/i.test(f.name))?.name;
  const picks = ['INBOX', archive, byRole('sent')].filter(Boolean);
  return [...new Set(picks)];
}

// query: { text, from, to, subject, since, before, unread, gmailQuery }
export function buildCriteria(query, account) {
  const crit = [];
  let needsUtf8 = false;
  const add = (key, value) => {
    const arg = textArg(value);
    if (typeof arg !== 'string') needsUtf8 = true;
    crit.push(key, arg);
  };
  if (query.gmailQuery && !account.gmail) throw new Error('gmail_query only works on Gmail accounts');
  if (query.gmailQuery) add('X-GM-RAW', query.gmailQuery);
  if (query.from) add('FROM', query.from);
  if (query.to) add('TO', query.to);
  if (query.subject) add('SUBJECT', query.subject);
  if (query.text) add('TEXT', query.text);
  if (query.since) crit.push('SINCE', imapDate(query.since));
  if (query.before) crit.push('BEFORE', imapDate(query.before));
  if (query.unread) crit.push('UNSEEN');
  if (query.unstarred) crit.push('UNFLAGGED');
  if (!crit.length) crit.push('ALL');
  return { criteria: crit, utf8: needsUtf8 };
}

function imapDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${iso} (use YYYY-MM-DD)`);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()}-${mon}-${d.getUTCFullYear()}`;
}

// Searches the given folders and returns the newest `limit` matches across them.
export async function search(client, account, folders, query, { limit = 20, preview = true } = {}) {
  const { criteria, utf8 } = buildCriteria(query, account);
  const hits = [];
  for (const folder of folders) {
    await client.examine(folder);
    const uids = await client.uidSearch(criteria, { utf8 });
    // UIDs rise with arrival, so the highest are the newest in this folder.
    const newest = uids.sort((a, b) => b - a).slice(0, limit);
    if (!newest.length) continue;
    const items =
      `UID FLAGS INTERNALDATE RFC822.SIZE${account.gmail ? ' X-GM-LABELS' : ''} ` +
      (preview ? `BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.${PREVIEW_BYTES}>` : HEADER_FIELDS);
    const fetched = await client.uidFetch(newest, items);
    for (const [uid, rec] of fetched) {
      const headerTok = preview ? rec['BODY[HEADER]'] : findKey(rec, 'BODY[HEADER.FIELDS');
      const headers = await parseHeaders(headerTok);
      const summary = {
        account: account.id,
        folder,
        uid,
        date: isoDate(asString(rec.INTERNALDATE)) || headers.date,
        from: headers.from,
        to: headers.to,
        subject: headers.subject,
        unread: !(rec.FLAGS || []).some((f) => String(f).toLowerCase() === '\\seen'),
        size: Number(asString(rec['RFC822.SIZE'])) || undefined,
        totalMatchesInFolder: uids.length,
      };
      if (account.gmail) summary.inInbox = folder.toUpperCase() === 'INBOX' || gmailLabels(rec).includes('\\Inbox');
      if (preview) {
        const text = findKey(rec, 'BODY[TEXT]');
        if (headerTok && text) summary.preview = await previewText(concat(asBytes(headerTok), asBytes(text)));
      }
      hits.push(summary);
    }
  }
  hits.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return hits.slice(0, limit);
}

export async function readMessage(client, account, folder, uid, { maxChars = 20000 } = {}) {
  await client.examine(folder);
  const sizeRec = (await client.uidFetch([uid], 'UID RFC822.SIZE FLAGS INTERNALDATE')).get(uid);
  if (!sizeRec) throw new Error(`No message with uid ${uid} in ${folder}. It may have been moved or deleted.`);
  const size = Number(asString(sizeRec['RFC822.SIZE'])) || 0;
  const truncatedSource = size > MAX_FULL_BYTES;
  const item = truncatedSource ? `BODY.PEEK[]<0.${MAX_FULL_BYTES}>` : 'BODY.PEEK[]';
  const rec = (await client.uidFetch([uid], `UID ${item}`)).get(uid);
  const raw = asBytes(findKey(rec, 'BODY[]'));
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });

  let body = email.text?.trim() || htmlToText(email.html || '');
  let bodyTruncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    bodyTruncated = true;
  }
  return {
    account: account.id,
    folder,
    uid,
    date: email.date || isoDate(asString(sizeRec.INTERNALDATE)),
    from: fmtAddr(email.from),
    replyTo: fmtList(email.replyTo),
    to: fmtList(email.to),
    cc: fmtList(email.cc),
    subject: email.subject || '',
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.headers?.find((h) => h.key === 'references')?.value?.trim(),
    unread: !(sizeRec.FLAGS || []).some((f) => String(f).toLowerCase() === '\\seen'),
    attachments: (email.attachments || []).map((a) => ({
      filename: a.filename || '(unnamed)',
      mimeType: a.mimeType,
      size: a.content?.byteLength,
    })),
    body,
    bodyTruncated: bodyTruncated || truncatedSource,
  };
}

// ---- formatting ---------------------------------------------------------------

export function gmailLabels(rec) {
  const list = rec?.['X-GM-LABELS'];
  return Array.isArray(list) ? list.map((l) => asString(l)) : [];
}

export function findKey(rec, prefix) {
  if (!rec) return null;
  const key = Object.keys(rec).find((k) => k.startsWith(prefix));
  return key ? rec[key] : null;
}

export async function parseHeaders(tok) {
  if (!tok) return {};
  const bytes = asBytes(tok);
  const email = await PostalMime.parse(concat(bytes, new TextEncoder().encode('\r\n')));
  return {
    from: fmtAddr(email.from),
    to: fmtList(email.to),
    subject: email.subject || '',
    date: email.date,
    messageId: email.messageId,
  };
}

async function previewText(bytes) {
  try {
    const email = await PostalMime.parse(bytes);
    const text = email.text?.trim() || htmlToText(email.html || '');
    return text.replace(/\s+/g, ' ').slice(0, 240);
  } catch {
    return undefined;
  }
}

export function fmtAddr(a) {
  if (!a) return '';
  if (a.group) return fmtList(a.group);
  return a.name ? `${a.name} <${a.address}>` : a.address || '';
}

export function fmtList(list) {
  if (!list || !list.length) return undefined;
  return list.map(fmtAddr).join(', ');
}

function isoDate(internal) {
  if (!internal) return undefined;
  const d = new Date(internal.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$2 $1 $3'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label} (${href})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
