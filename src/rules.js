// Sender rules: a block list (always trashed, checked every 15 minutes), a
// keep list (never unsubscribed or blocked; optionally archived, filed, or
// quietly trashed while staying subscribed), a mailing-list survey for the first cleanups, and real
// one-click unsubscribes (RFC 8058) that never open links inside an email.

import PostalMime from 'postal-mime';
import { asBytes } from './imap.js';
import { findKey, concat } from './mail.js';
import { describe, apply, writeLog, groupBy, folderMap } from './manage.js';
import { store } from './state.js';

const LIST_HEADERS = 'BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID LIST-ID LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST)]';

// ---- rules storage ----------------------------------------------------------------------

export async function getRules(kv) {
  return (await kv.get('rules', 'json')) || { block: [], keep: [] };
}

export async function saveRules(kv, rules) {
  // KV takes about one write per second per key; wait and retry when rules are saved back to back.
  for (let i = 0; ; i++) {
    try {
      return await kv.put('rules', JSON.stringify(rules));
    } catch (e) {
      if (i >= 4 || !/429|Too Many/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
}

export function normalizeSender(s) {
  const m = /<([^>]+)>/.exec(String(s));
  return (m ? m[1] : String(s)).trim().toLowerCase().replace(/^@/, '');
}

// "news@x.com" matches only that address; "x.com" matches x.com and any subdomain.
export function senderMatches(rule, address) {
  const a = normalizeSender(address);
  const r = rule.match;
  if (r.includes('@')) return a === r;
  const domain = a.split('@')[1] || '';
  return domain === r || domain.endsWith(`.${r}`);
}

export function ruleFor(rules, address) {
  // Keep wins over block, so a list the user wants is never trashed by a broad domain block.
  const keep = rules.keep.find((r) => senderMatches(r, address));
  if (keep) return { kind: 'keep', rule: keep };
  const block = rules.block.find((r) => senderMatches(r, address));
  if (block) return { kind: 'block', rule: block };
  return null;
}

// ---- headers ------------------------------------------------------------------------------------

export async function listInfo(headerBytes) {
  const email = await PostalMime.parse(concat(headerBytes, new TextEncoder().encode('\r\n')));
  const h = (k) => email.headers?.find((x) => x.key === k)?.value?.trim() || '';
  const unsub = h('list-unsubscribe');
  const urls = [...unsub.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  const https = urls.find((u) => /^https:\/\//i.test(u));
  return {
    from: email.from?.address || '',
    fromName: email.from?.name || '',
    subject: email.subject || '',
    date: email.date,
    messageId: email.messageId,
    listId: h('list-id').replace(/^.*<([^>]+)>.*$/, '$1'),
    oneClickUrl: https && /one-click/i.test(h('list-unsubscribe-post')) ? https : null,
    mailto: urls.find((u) => /^mailto:/i.test(u)) || null,
    isList: Boolean(unsub || h('list-id')),
  };
}

// ---- survey for the first cleanups ---------------------------------------------------------

// Groups the newest `scan` messages in a folder by sender, flagging mailing lists.
export async function survey(client, account, folder, rules, { scan = 300 } = {}) {
  await client.examine(folder);
  const uids = (await client.uidSearch(['ALL'])).sort((a, b) => b - a).slice(0, scan);
  if (!uids.length) return [];
  const fetched = await client.uidFetch(uids, `UID ${LIST_HEADERS}`);
  const groups = new Map();
  for (const [uid, rec] of fetched) {
    const info = await listInfo(asBytes(findKey(rec, 'BODY[HEADER.FIELDS')));
    if (!info.from) continue;
    const key = info.listId || info.from.toLowerCase();
    const g = groups.get(key) || {
      sender: info.from.toLowerCase(),
      name: info.fromName || info.from,
      list: info.isList,
      oneClickUnsubscribe: false,
      count: 0,
      newest: '',
      subjects: [],
      sample: null,
    };
    g.count++;
    g.oneClickUnsubscribe ||= Boolean(info.oneClickUrl);
    if (!g.newest || String(info.date) > g.newest) g.newest = String(info.date || '');
    if (g.subjects.length < 3) g.subjects.push(info.subject);
    g.sample ||= { account: account.id, folder, uid };
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rule: ruleFor(rules, g.sender)?.kind || null }))
    .sort((a, b) => b.count - a.count);
}

// ---- one-click unsubscribe ---------------------------------------------------------------------

export async function unsubscribe(client, account, folder, uid, rules) {
  await client.examine(folder);
  const rec = (await client.uidFetch([uid], `UID ${LIST_HEADERS}`)).get(uid);
  if (!rec) throw new Error(`No message ${uid} in ${folder}.`);
  const info = await listInfo(asBytes(findKey(rec, 'BODY[HEADER.FIELDS')));
  if (ruleFor(rules, info.from)?.kind === 'keep') {
    return { done: false, why: `${info.from} is on the user's keep list.`, info };
  }
  if (!info.oneClickUrl) {
    return {
      done: false,
      why: info.mailto
        ? 'This sender only offers an email-based unsubscribe, which would mean sending mail. Block the sender instead.'
        : 'This message has no standard unsubscribe. It is probably cold outreach: block the sender instead.',
      info,
    };
  }
  // RFC 8058: a bare POST to the header's https URL. No page is opened, no link in the body is followed.
  const res = await fetch(info.oneClickUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'mail-connector' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
  });
  const ok = res.status < 400;
  return { done: ok, status: res.status, why: ok ? 'Unsubscribed with the sender’s one-click unsubscribe.' : `The sender’s unsubscribe answered ${res.status}.`, info };
}

// ---- automatic sweep (every 15 minutes) ------------------------------------------------------

// Looks only at mail that arrived in each INBOX since the last run.
export async function autoSweep(env, accounts, withAccount, openSocket) {
  const kv = store(env);
  const rules = await getRules(kv);
  const active = rules.block.length || rules.keep.some((r) => r.then && r.then !== 'leave');
  if (!active) return { skipped: 'no rules' };
  const state = (await kv.get('rules:state', 'json')) || {};
  const before = JSON.stringify(state);
  const summary = {};

  for (const account of accounts.filter((a) => a.password)) {
    try {
      const result = await withAccount(account, openSocket, async (client) => {
        await client.examine('INBOX');
        const first = state[account.id] === undefined;
        const last = state[account.id] || 0;
        const uids = (await client.uidSearch(['UID', `${last + 1}:*`])).filter((u) => u > last);
        if (first) {
          // First run for this account: start from now; the backlog is handled in sweeps with the user.
          state[account.id] = uids.length ? uids.reduce((m, u) => (u > m ? u : m), 0) : 0;
          return { started: true };
        }
        if (!uids.length) return { new: 0 };
        state[account.id] = uids.reduce((m, u) => (u > m ? u : m), last);
        const fetched = await client.uidFetch(uids.slice(-200), `UID ${LIST_HEADERS}`);
        const toTrash = [];
        const toArchive = [];
        const toFolder = new Map();
        for (const [uid, rec] of fetched) {
          const info = await listInfo(asBytes(findKey(rec, 'BODY[HEADER.FIELDS')));
          const hit = ruleFor(rules, info.from);
          if (!hit) continue;
          const item = { account: account.id, folder: 'INBOX', uid };
          if (hit.kind === 'block' || hit.rule.then === 'trash') toTrash.push(item);
          else if (hit.rule.then === 'archive') toArchive.push(item);
          else if (hit.rule.then?.startsWith('folder:')) {
            const f = hit.rule.then.slice(7);
            toFolder.set(f, [...(toFolder.get(f) || []), item]);
          }
        }
        const done = [];
        const run = async (items, action, to) => {
          if (!items.length) return;
          const described = await describe(client, account, items);
          const r = await apply(client, account, described, action, to);
          done.push(...r.done);
        };
        await run(toTrash, 'trash');
        await run(toArchive, 'archive');
        for (const [f, items] of toFolder) await run(items, 'move', f);
        if (done.length) {
          for (const [action, entries] of groupBy(done, (e) => e.action)) {
            await writeLog(kv, {
              id: crypto.randomUUID().slice(0, 8),
              at: Date.now(),
              action,
              auto: 'sender rules',
              toFolder: entries[0].toFolder || entries[0].label,
              count: entries.length,
              entries,
            });
          }
        }
        return { new: uids.length, handled: done.length };
      });
      summary[account.id] = result;
    } catch (e) {
      summary[account.id] = { error: e.message };
    }
  }
  // Save only when a mailbox moved on (KV allows ~1,000 writes/day on the free plan).
  if (JSON.stringify(state) !== before) await kv.put('rules:state', JSON.stringify(state));
  return summary;
}

export { folderMap };
