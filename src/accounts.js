// The mailboxes this connector can read, from settings.js. App passwords live in
// Worker secrets named by each mailbox's `secret` (set with the setup scripts).

import SETTINGS from '../settings.js';

export { SETTINGS };

export const ACCOUNTS = SETTINGS.mailboxes.map((m) => ({
  id: String(m.id),
  label: String(m.label || m.id),
  host: String(m.host),
  port: Number(m.port) || 993,
  user: String(m.user),
  secret: String(m.secret),
  gmail: Boolean(m.gmail),
}));

export function accountsFrom(env) {
  return ACCOUNTS.map((a) => ({ ...a, password: (env[a.secret] || '').replace(/\s+/g, '') }));
}

// Every address that belongs to the user: the mailboxes plus any aliases.
export const OWN_ADDRESSES = [...ACCOUNTS.map((a) => a.user), ...(SETTINGS.otherAddresses || [])];

// Domains too broad to block or file as a whole: big free mail providers and
// the user's own domains (and the domains of their own mailboxes).
const PROVIDERS = ['gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'aol.com', 'proton.me', 'protonmail.com'];
export const BROAD_DOMAINS = [
  ...new Set([
    ...PROVIDERS,
    ...(SETTINGS.ownDomains || []).map((d) => String(d).toLowerCase()),
    ...OWN_ADDRESSES.map((a) => String(a).split('@')[1]?.toLowerCase()).filter(Boolean),
  ]),
];

// A short list of the mailbox labels for tool descriptions: "iCloud, Gmail".
export const MAILBOX_NAMES = ACCOUNTS.map((a) => a.label).join(', ');
