// A small IMAP client with a narrow, guarded set of changes.
//
// Reading: log in, list folders, open a folder with EXAMINE (read-only), search,
// and fetch with BODY.PEEK so nothing is marked as read.
// Changing: only what mail management needs. Move messages between folders,
// set or clear the \Seen and \Flagged flags, add or remove Gmail labels, and
// save a draft into the Drafts folder. Every command passes an allowlist and
// argument checks here, so a bug elsewhere cannot delete a folder, expunge a
// mailbox, or permanently remove mail. (\Deleted + UID EXPUNGE are used only
// inside move(), as the fallback for servers without MOVE, on the exact UIDs
// that were just copied.)
//
// The socket is injected: the Worker passes one from cloudflare:sockets, the
// local test script passes one built on node:tls. Both expose
// { readable: ReadableStream<Uint8Array>, writable: WritableStream, close() }.

const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

// The only verbs this client will ever send.
const ALLOWED = new Set([
  'CAPABILITY', 'LOGIN', 'LIST', 'EXAMINE', 'SELECT', 'UID SEARCH', 'UID FETCH', 'LOGOUT', 'NOOP',
  'UID MOVE', 'UID COPY', 'UID STORE', 'UID EXPUNGE', 'APPEND',
]);
const STORE_OPS = /^[+-](FLAGS|X-GM-LABELS)(\.SILENT)?$/i;
const SAFE_FLAGS = new Set(['\\SEEN', '\\FLAGGED']);
const UIDSET = /^\d+(:\d+)?(,\d+(:\d+)?)*$/;

export class ImapError extends Error {}

export class ImapClient {
  constructor(socket, { timeoutMs = 25000 } = {}) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buf = new Uint8Array(0);
    this.tagN = 0;
    this.timeoutMs = timeoutMs;
    this.capabilities = new Set();
    this.expungeAllowedFor = null; // UID set allowed for \Deleted + UID EXPUNGE, set only inside move()
    this.appendAllowedTo = null; // quoted mailbox name allowed for APPEND, set only inside appendDraft()
  }

  // ---- low-level reading ------------------------------------------------

  async fill() {
    const read = this.reader.read();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ImapError('Mail server did not answer in time')), this.timeoutMs);
    });
    let result;
    try {
      result = await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (result.done) throw new ImapError('Mail server closed the connection');
    const next = new Uint8Array(this.buf.length + result.value.length);
    next.set(this.buf);
    next.set(result.value, this.buf.length);
    this.buf = next;
  }

  // Reads one complete response: a line plus any literals it announces.
  // Returns an array of parts: strings (line text, latin1) and Uint8Array (literal bytes).
  async readResponse() {
    const parts = [];
    for (;;) {
      let idx;
      while ((idx = indexOfCRLF(this.buf)) < 0) await this.fill();
      const line = latin1.decode(this.buf.subarray(0, idx));
      this.buf = this.buf.subarray(idx + 2);
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (!lit) {
        parts.push(line);
        return parts;
      }
      parts.push(line.slice(0, lit.index));
      const n = Number(lit[1]);
      while (this.buf.length < n) await this.fill();
      parts.push(this.buf.slice(0, n));
      this.buf = this.buf.subarray(n);
    }
  }

  async write(text) {
    await this.writer.write(typeof text === 'string' ? enc.encode(text) : text);
  }

  // ---- commands -----------------------------------------------------------

  // args: array of strings (sent as-is) and { literal: string } objects.
  async command(verb, args = []) {
    if (!ALLOWED.has(verb)) throw new ImapError(`Blocked IMAP command: ${verb}`);
    if (verb === 'UID FETCH') {
      const joined = args.filter((a) => typeof a === 'string').join(' ').toUpperCase();
      if (/BODY\[/.test(joined.replace(/BODY\.PEEK\[/g, ''))) throw new ImapError('Fetch must use BODY.PEEK');
      if (/RFC822(?!\.SIZE)/.test(joined)) throw new ImapError('Fetch must use BODY.PEEK');
    }
    if (['UID MOVE', 'UID COPY', 'UID STORE', 'UID EXPUNGE'].includes(verb) && !UIDSET.test(String(args[0]))) {
      throw new ImapError(`${verb} needs explicit UIDs`);
    }
    if (verb === 'UID STORE') {
      const [uids, op, list] = args;
      if (!STORE_OPS.test(op)) throw new ImapError(`Blocked STORE command: ${op}`);
      const items = String(list).replace(/^\(|\)$/g, '').match(/"(?:[^"\\]|\\.)*"|\S+/g) || [];
      if (/FLAGS/i.test(op) && !/X-GM/i.test(op)) {
        for (const f of items) {
          const flag = f.toUpperCase();
          const deleteOk = flag === '\\DELETED' && op.startsWith('+') && this.expungeAllowedFor === uids;
          if (!SAFE_FLAGS.has(flag) && !deleteOk) throw new ImapError(`Blocked flag: ${f}`);
        }
      }
    }
    if (verb === 'UID EXPUNGE' && this.expungeAllowedFor !== args[0]) throw new ImapError('Blocked EXPUNGE');
    if (verb === 'APPEND' && args[0] !== this.appendAllowedTo) throw new ImapError('Drafts can only go to the Drafts folder');
    const tag = `A${++this.tagN}`;
    const segments = [`${tag} ${verb}`];
    // Send the command, pausing at each literal for the server's "+" go-ahead.
    let pending = segments[0];
    for (const arg of args) {
      if (typeof arg === 'string') {
        pending += ` ${arg}`;
        continue;
      }
      const bytes = enc.encode(arg.literal);
      await this.write(`${pending} {${bytes.length}}\r\n`);
      await this.waitContinue(tag);
      await this.write(bytes);
      pending = '';
    }
    await this.write(`${pending}\r\n`);

    const untagged = [];
    for (;;) {
      const resp = await this.readResponse();
      const head = resp[0];
      if (head.startsWith('* ')) {
        untagged.push(resp);
        continue;
      }
      if (head.startsWith('+')) continue; // stray continuation
      if (head.startsWith(`${tag} `)) {
        const rest = head.slice(tag.length + 1);
        const status = rest.split(' ')[0].toUpperCase();
        if (status !== 'OK') {
          const why = rest.slice(status.length).trim();
          throw new ImapError(verb === 'LOGIN' ? `Sign-in refused by the mail server: ${why}` : `${verb} failed: ${why}`);
        }
        return { untagged, text: rest };
      }
    }
  }

  async waitContinue(tag) {
    for (;;) {
      const resp = await this.readResponse();
      if (resp[0].startsWith('+')) return;
      if (resp[0].startsWith(`${tag} `)) throw new ImapError(`Server refused: ${resp[0]}`);
    }
  }

  // ---- session ------------------------------------------------------------

  async greet() {
    const resp = await this.readResponse();
    if (!/^\* (OK|PREAUTH)/i.test(resp[0])) throw new ImapError(`Unexpected greeting: ${resp[0]}`);
  }

  async login(user, pass) {
    await this.command('LOGIN', [quote(user), quote(pass)]);
    const { untagged } = await this.command('CAPABILITY');
    for (const r of untagged) {
      const m = /^\* CAPABILITY (.*)$/i.exec(r[0]);
      if (m) for (const c of m[1].split(' ')) this.capabilities.add(c.toUpperCase());
    }
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {
      // the server may hang up first
    }
    try {
      await this.socket.close();
    } catch {
      // already closed
    }
  }

  // Returns [{ name, flags: [...], delimiter }]
  async list() {
    const { untagged } = await this.command('LIST', ['""', '"*"']);
    const out = [];
    for (const r of untagged) {
      const tokens = parseTokens(r);
      if (String(tokens[1]).toUpperCase() !== 'LIST') continue;
      const flags = (tokens[2] || []).map(String);
      const delimiter = tokens[3] == null ? null : asString(tokens[3]);
      const name = decodeMutf7(asString(tokens[4]));
      out.push({ name, flags, delimiter });
    }
    return out;
  }

  async examine(folder) {
    const { untagged } = await this.command('EXAMINE', [mailboxArg(folder)]);
    let exists = 0;
    for (const r of untagged) {
      const m = /^\* (\d+) EXISTS/i.exec(r[0]);
      if (m) exists = Number(m[1]);
    }
    return { exists };
  }

  // Opens a folder for changes. Returns { exists, uidValidity }.
  async select(folder) {
    const { untagged } = await this.command('SELECT', [mailboxArg(folder)]);
    let exists = 0;
    let uidValidity = null;
    for (const r of untagged) {
      const m = /^\* (\d+) EXISTS/i.exec(r[0]);
      if (m) exists = Number(m[1]);
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(r[0]);
      if (v) uidValidity = v[1];
    }
    return { exists, uidValidity };
  }

  // Moves UIDs from the selected folder to `dest`. Returns Map<srcUid, destUid>
  // when the server reports it (COPYUID), otherwise an empty map.
  async move(uids, dest) {
    if (!uids.length) return new Map();
    const set = uids.join(',');
    if (this.capabilities.has('MOVE')) {
      const { untagged, text } = await this.command('UID MOVE', [set, mailboxArg(dest)]);
      return copyUidMap([text, ...untagged.map((r) => r[0])]);
    }
    if (!this.capabilities.has('UIDPLUS')) throw new ImapError('This mail server cannot move messages safely');
    const { text } = await this.command('UID COPY', [set, mailboxArg(dest)]);
    this.expungeAllowedFor = set;
    try {
      await this.command('UID STORE', [set, '+FLAGS.SILENT', '(\\Deleted)']);
      await this.command('UID EXPUNGE', [set]);
    } finally {
      this.expungeAllowedFor = null;
    }
    return copyUidMap([text]);
  }

  async storeFlags(uids, add, flags) {
    if (!uids.length) return;
    await this.command('UID STORE', [uids.join(','), `${add ? '+' : '-'}FLAGS.SILENT`, `(${flags.join(' ')})`]);
  }

  async storeLabels(uids, add, labels) {
    if (!uids.length) return;
    const list = labels.map((l) => (l.startsWith('\\') ? l : quote(encodeMutf7(l)))).join(' ');
    await this.command('UID STORE', [uids.join(','), `${add ? '+' : '-'}X-GM-LABELS.SILENT`, `(${list})`]);
  }

  // Saves a complete RFC 5322 message into the Drafts folder. Returns its UID if reported.
  async appendDraft(draftsFolder, message) {
    const box = mailboxArg(draftsFolder);
    this.appendAllowedTo = box;
    try {
      const { text } = await this.command('APPEND', [box, '(\\Draft \\Seen)', { literal: message }]);
      const m = /\[APPENDUID \d+ (\d+)\]/i.exec(text);
      return m ? Number(m[1]) : null;
    } finally {
      this.appendAllowedTo = null;
    }
  }

  // criteria: array of strings and { literal } objects, already in IMAP form.
  async uidSearch(criteria, { utf8: needsCharset = false } = {}) {
    const args = needsCharset ? ['CHARSET', 'UTF-8', ...criteria] : criteria;
    const { untagged } = await this.command('UID SEARCH', args);
    const uids = [];
    for (const r of untagged) {
      const m = /^\* SEARCH ?(.*)$/i.exec(r[0]);
      if (m && m[1].trim()) for (const n of m[1].trim().split(/\s+/)) uids.push(Number(n));
    }
    return uids;
  }

  // Returns Map<uid, { key: value }> where keys are fetch item names (upper case).
  async uidFetch(uids, items) {
    if (!uids.length) return new Map();
    const { untagged } = await this.command('UID FETCH', [uids.join(','), `(${items})`]);
    const out = new Map();
    for (const r of untagged) {
      const tokens = parseTokens(r);
      if (String(tokens[2]).toUpperCase() !== 'FETCH') continue;
      const list = tokens[3] || [];
      const rec = {};
      for (let i = 0; i + 1 < list.length; i += 2) rec[String(list[i]).toUpperCase()] = list[i + 1];
      const uid = Number(asString(rec.UID));
      if (uid) out.set(uid, rec);
    }
    return out;
  }
}

// ---- helpers ----------------------------------------------------------------

// Expands "3,5:7" into [3,5,6,7].
export function expandUidSet(set) {
  const out = [];
  for (const part of String(set).split(',')) {
    const [a, b] = part.split(':').map(Number);
    if (b === undefined) out.push(a);
    else for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
  }
  return out;
}

// Reads "[COPYUID <validity> <src set> <dst set>]" out of response lines.
export function copyUidMap(lines) {
  for (const line of lines) {
    const m = /\[COPYUID \d+ ([\d:,]+) ([\d:,]+)\]/i.exec(line || '');
    if (!m) continue;
    const src = expandUidSet(m[1]);
    const dst = expandUidSet(m[2]);
    const map = new Map();
    src.forEach((u, i) => map.set(u, dst[i]));
    return map;
  }
  return new Map();
}

function indexOfCRLF(buf) {
  for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}

export function quote(s) {
  if (/[\r\n]/.test(s)) throw new ImapError('Line breaks are not allowed here');
  return `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
}

// An argument that may hold non-ASCII text: quoted when plain, literal otherwise.
export function textArg(s) {
  return /^[\x20-\x7e]*$/.test(s) ? quote(s) : { literal: s };
}

function mailboxArg(name) {
  return quote(encodeMutf7(name));
}

// Turns a response (line parts + literal bytes) into nested tokens.
// Atoms come back as strings, quoted strings as { s }, literals as Uint8Array,
// NIL as null, and parenthesized lists as arrays. Fetch keys such as
// BODY[HEADER.FIELDS (FROM)]<0> are kept whole as one atom.
export function parseTokens(parts) {
  const root = [];
  const stack = [root];
  for (const part of parts) {
    if (part instanceof Uint8Array) {
      stack[stack.length - 1].push(part);
      continue;
    }
    let i = 0;
    const s = part;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ') {
        i++;
      } else if (ch === '(') {
        const list = [];
        stack[stack.length - 1].push(list);
        stack.push(list);
        i++;
      } else if (ch === ')') {
        if (stack.length > 1) stack.pop();
        i++;
      } else if (ch === '"') {
        let j = i + 1;
        let out = '';
        while (j < s.length && s[j] !== '"') {
          if (s[j] === '\\' && j + 1 < s.length) j++;
          out += s[j++];
        }
        stack[stack.length - 1].push({ s: out });
        i = j + 1;
      } else {
        // atom, possibly with a [section] that can hold spaces and parens
        let j = i;
        let depth = 0;
        while (j < s.length) {
          const c = s[j];
          if (c === '[') depth++;
          else if (c === ']') depth--;
          else if (depth === 0 && (c === ' ' || c === '(' || c === ')')) break;
          j++;
        }
        const atom = s.slice(i, j);
        stack[stack.length - 1].push(atom.toUpperCase() === 'NIL' ? null : atom);
        i = j;
      }
    }
  }
  return root;
}

export function asString(tok) {
  if (tok == null) return '';
  if (tok instanceof Uint8Array) return utf8.decode(tok);
  if (typeof tok === 'object' && 's' in tok) return tok.s;
  return String(tok);
}

export function asBytes(tok) {
  if (tok instanceof Uint8Array) return tok;
  return enc.encode(asString(tok));
}

// Modified UTF-7 (RFC 3501 §5.1.3), used for folder names.
export function decodeMutf7(s) {
  return s.replace(/&([^-]*)-/g, (_, b64) => {
    if (b64 === '') return '&';
    const bin = atob(b64.replace(/,/g, '/') + '==='.slice((b64.length + 3) % 4));
    let out = '';
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return out;
  });
}

export function encodeMutf7(s) {
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    let bin = '';
    for (const ch of run) {
      const c = ch.charCodeAt(0);
      bin += String.fromCharCode(c >> 8, c & 255);
    }
    out += `&${btoa(bin).replace(/=+$/, '').replace(/\//g, ',')}-`;
    run = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += s[i] === '&' ? '&-' : s[i];
    } else {
      run += s[i];
    }
  }
  flush();
  return out;
}
