// Mail management: trash, archive, move, mark read/unread, star, plus an
// activity log and undo. Nothing here deletes mail permanently: "trash" moves
// to the account's Trash folder, where the provider keeps it for ~30 days.
//
// Batches above CONFIRM_ABOVE messages need a confirmation token from a dry
// run first, so Claude always tells the user the size of a big sweep before doing it.

import { listFolders, gmailLabels, parseHeaders, findKey } from './mail.js';
import { asString, quote } from './imap.js';

export const CONFIRM_ABOVE = 10;
export const MAX_PER_CALL = 200;
const LOG_TTL = 60 * 60 * 24 * 60; // keep the activity log 60 days
const CONFIRM_TTL = 60 * 15;

export const ACTIONS = ['trash', 'archive', 'move', 'mark_read', 'mark_unread', 'star', 'unstar'];

// ---- folders -----------------------------------------------------------------

export async function folderMap(client, account) {
  const folders = await listFolders(client);
  const byRole = (r) => folders.find((f) => f.role === r)?.name;
  const byName = (re) => folders.find((f) => re.test(f.name))?.name;
  return {
    names: folders.map((f) => f.name),
    trash: byRole('trash') || byName(/^(trash|deleted messages|\[gmail\]\/trash)$/i),
    archive: account.gmail ? null : byRole('archive') || byName(/^archive$/i),
    all: byRole('all'),
    drafts: byRole('drafts') || byName(/^drafts$/i),
    inbox: 'INBOX',
  };
}

// ---- resolving what to act on --------------------------------------------------

// items: [{ account, folder, uid }]. Returns the same items enriched with
// sender, subject, date, Message-ID, flags and (Gmail) labels; missing ones dropped.
export async function describe(client, account, items) {
  const byFolder = groupBy(items, (i) => i.folder);
  const out = [];
  for (const [folder, list] of byFolder) {
    await client.examine(folder);
    const fetched = await client.uidFetch(
      list.map((i) => i.uid),
      `UID FLAGS${account.gmail ? ' X-GM-LABELS' : ''} BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]`
    );
    for (const item of list) {
      const rec = fetched.get(item.uid);
      if (!rec) continue;
      const h = await parseHeaders(findKey(rec, 'BODY[HEADER.FIELDS'));
      const flags = (rec.FLAGS || []).map((f) => String(f).toLowerCase());
      out.push({
        account: account.id,
        folder,
        uid: item.uid,
        from: h.from,
        subject: h.subject,
        date: h.date,
        messageId: h.messageId,
        seen: flags.includes('\\seen'),
        flagged: flags.includes('\\flagged'),
        labels: account.gmail ? gmailLabels(rec) : undefined,
      });
    }
  }
  return out;
}

export function summarize(items) {
  const byAccount = {};
  const senders = {};
  for (const i of items) {
    byAccount[i.account] = (byAccount[i.account] || 0) + 1;
    const who = (i.from || '(unknown)').replace(/^.*<([^>]+)>.*$/, '$1');
    senders[who] = (senders[who] || 0) + 1;
  }
  const dates = items.map((i) => i.date).filter(Boolean).sort();
  return {
    count: items.length,
    byAccount,
    topSenders: Object.entries(senders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sender, count]) => ({ sender, count })),
    oldest: dates[0],
    newest: dates[dates.length - 1],
    sampleSubjects: items.slice(0, 8).map((i) => i.subject),
  };
}

// ---- confirmation tokens --------------------------------------------------------

export async function saveConfirmation(kv, plan) {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await kv.put(`confirm:${token}`, JSON.stringify(plan), { expirationTtl: CONFIRM_TTL });
  return token;
}

export async function takeConfirmation(kv, token) {
  const raw = await kv.get(`confirm:${token}`);
  if (!raw) return null;
  await kv.delete(`confirm:${token}`);
  return JSON.parse(raw);
}

// ---- doing it ----------------------------------------------------------------------

// Applies `action` to described items of ONE account. Returns log entries.
export async function apply(client, account, items, action, toFolder) {
  const folders = await folderMap(client, account);
  const done = [];
  const skipped = [];
  for (const [folder, list] of groupBy(items, (i) => i.folder)) {
    const uids = list.map((i) => i.uid);
    await client.select(folder);
    const record = (i, extra) => done.push({ ...pick(i), action, ...extra });

    if (action === 'mark_read' || action === 'mark_unread') {
      const want = action === 'mark_read';
      const change = list.filter((i) => i.seen !== want);
      await client.storeFlags(change.map((i) => i.uid), want, ['\\Seen']);
      change.forEach((i) => record(i));
      continue;
    }
    if (action === 'star' || action === 'unstar') {
      const want = action === 'star';
      const change = list.filter((i) => i.flagged !== want);
      await client.storeFlags(change.map((i) => i.uid), want, ['\\Flagged']);
      change.forEach((i) => record(i));
      continue;
    }

    if (action === 'trash') {
      if (!folders.trash) throw new Error(`${account.label}: no Trash folder found`);
      if (folder === folders.trash) {
        list.forEach((i) => skipped.push({ ...pick(i), why: 'already in Trash' }));
        continue;
      }
      const map = await client.move(uids, folders.trash);
      list.forEach((i) => record(i, { toFolder: folders.trash, toUid: map.get(i.uid) || null, labels: i.labels }));
      continue;
    }

    if (action === 'archive') {
      if (account.gmail) {
        const inInbox = list.filter((i) => (i.labels || []).includes('\\Inbox') || folder === 'INBOX');
        await client.storeLabels(inInbox.map((i) => i.uid), false, ['\\Inbox']);
        inInbox.forEach((i) => record(i));
        list.filter((i) => !inInbox.includes(i)).forEach((i) => skipped.push({ ...pick(i), why: 'not in the inbox' }));
      } else {
        if (!folders.archive) throw new Error(`${account.label}: no Archive folder found`);
        if (folder === folders.archive) {
          list.forEach((i) => skipped.push({ ...pick(i), why: 'already archived' }));
          continue;
        }
        const map = await client.move(uids, folders.archive);
        list.forEach((i) => record(i, { toFolder: folders.archive, toUid: map.get(i.uid) || null }));
      }
      continue;
    }

    if (action === 'move') {
      const dest = folders.names.find((n) => n.toLowerCase() === String(toFolder || '').toLowerCase());
      if (!dest) throw new Error(`${account.label}: no folder named "${toFolder}". Folders: ${folders.names.join(', ')}`);
      if (account.gmail) {
        // Gmail folders are labels: add the label and take it out of the inbox.
        await client.storeLabels(uids, true, [dest]);
        const inInbox = list.filter((i) => (i.labels || []).includes('\\Inbox'));
        await client.storeLabels(inInbox.map((i) => i.uid), false, ['\\Inbox']);
        list.forEach((i) => record(i, { label: dest, removedInbox: inInbox.includes(i) }));
      } else {
        if (folder === dest) continue;
        const map = await client.move(uids, dest);
        list.forEach((i) => record(i, { toFolder: dest, toUid: map.get(i.uid) || null }));
      }
      continue;
    }
    throw new Error(`Unknown action ${action}`);
  }
  return { done, skipped };
}

// Reverses logged entries for ONE account. Returns how many were restored.
export async function reverse(client, account, entries) {
  let restored = 0;
  const problems = [];
  for (const e of entries) {
    try {
      if (e.action === 'mark_read' || e.action === 'mark_unread') {
        await client.select(e.folder);
        await client.storeFlags([e.uid], e.action === 'mark_unread', ['\\Seen']);
      } else if (e.action === 'star' || e.action === 'unstar') {
        await client.select(e.folder);
        await client.storeFlags([e.uid], e.action === 'unstar', ['\\Flagged']);
      } else if (e.action === 'archive' && account.gmail) {
        await client.select(e.folder);
        await client.storeLabels([e.uid], true, ['\\Inbox']);
      } else if (e.action === 'move' && account.gmail) {
        await client.select(e.folder);
        await client.storeLabels([e.uid], false, [e.label]);
        if (e.removedInbox) await client.storeLabels([e.uid], true, ['\\Inbox']);
      } else {
        // A real move (trash, iCloud archive/move): move it back.
        await client.select(e.toFolder);
        let uid = e.toUid;
        if (!uid && e.messageId) {
          const found = await client.uidSearch(['HEADER', 'Message-ID', quote(e.messageId)]);
          uid = found[0];
        }
        if (!uid) throw new Error('could not find it in ' + e.toFolder);
        const map = await client.move([uid], e.folder);
        // Gmail drops labels when a message goes to Trash; put them back.
        if (account.gmail && e.labels?.length) {
          const back = map.get(uid);
          if (back) {
            await client.select(e.folder);
            const keep = e.labels.filter((l) => !/^\\(Trash|Spam|Draft|Sent)$/i.test(l));
            if (keep.length) await client.storeLabels([back], true, keep);
          }
        }
      }
      restored++;
    } catch (err) {
      problems.push(`${e.subject || e.uid}: ${err.message}`);
    }
  }
  return { restored, problems };
}

// ---- activity log -----------------------------------------------------------------

function logKey(at, id) {
  // Newest first when KV lists keys in ascending order.
  return `log:${String(9999999999999 - at).padStart(13, '0')}:${id}`;
}

export async function writeLog(kv, batch) {
  await kv.put(logKey(batch.at, batch.id), JSON.stringify(batch), { expirationTtl: LOG_TTL });
}

export async function listLog(kv, limit = 20) {
  const { keys } = await kv.list({ prefix: 'log:', limit });
  const out = [];
  for (const k of keys) {
    const raw = await kv.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  return out;
}

export async function findBatch(kv, id) {
  const all = await listLog(kv, 100);
  if (!id || id === 'last') return all.find((b) => !b.undone && b.action !== 'draft' && b.action !== 'unsubscribe' && !b.action.startsWith('calendar_'));
  return all.find((b) => b.id === id);
}

export async function markUndone(kv, batch) {
  batch.undone = true;
  batch.undoneAt = Date.now();
  await writeLog(kv, batch);
}

// ---- helpers ------------------------------------------------------------------------

function pick(i) {
  return { account: i.account, folder: i.folder, uid: i.uid, from: i.from, subject: i.subject, messageId: i.messageId };
}

export function groupBy(list, fn) {
  const m = new Map();
  for (const x of list) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export { asString };
