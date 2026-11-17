# janet-mail

Your own private email connector for Claude. It runs on your free Cloudflare account, signs in to your mailboxes with app passwords, and lets Claude (web, desktop, phone) search, read and tidy your mail and your iCloud calendar. Only you can connect to it: sign-in goes through GitHub and admits one GitHub account, yours.

## What Claude can do with it

- **Read:** list your mailboxes and folders, search across all of them at once (Gmail search syntax works for Gmail accounts), open a message, download an original message with its attachments.
- **Tidy:** move to Trash, archive, file into a folder or label, mark read or unread, star. Batches above 10 messages wait for your OK first. Every action goes in an activity log and can be undone for 60 days.
- **Drafts:** save a draft or a reply in the right account's Drafts folder. You review and send it yourself.
- **Sender rules:** a block list (straight to Trash) and a keep list (leave, archive, file, or quietly trash), applied to new inbox mail every 15 minutes. One-click unsubscribe for real mailing lists.
- **iCloud calendar (optional):** list, add, change and delete events on the calendars you name, with undo.

It never sends email and never permanently deletes anything.

## What you need

- A free Cloudflare account (cloudflare.com).
- A free GitHub account (github.com). Used only for signing in.
- A Mac with Node.js installed (nodejs.org, the LTS version).
- For each mailbox: two-step sign-in turned on, and an **app password** made for this connector.
  - Gmail / Google Workspace: myaccount.google.com/apppasswords (16 letters).
  - iCloud: account.apple.com, Sign-In and Security, App-Specific Passwords (xxxx-xxxx-xxxx-xxxx). The same password also opens your iCloud calendar.
- Claude on a plan that allows custom connectors.

## Setup outline

1. **Install:** in this folder, `npm install`, then `npm test` (should say all tests pass).
2. **Fill in `settings.js`:** your name, your mailboxes, other addresses of yours, your own domains, time zone, iCloud calendar names, your GitHub ID number. The web address (`publicUrl`) is filled in at step 5.
3. **Sign in to Cloudflare:** `npx wrangler login`.
4. **Create storage:** `scripts/setup-cloudflare.sh` creates the sign-in store and the rules database and writes their ids into `wrangler.jsonc`.
5. **First deploy:** `npx wrangler deploy`. It prints the address (`https://janet-mail.<something>.workers.dev`). Put that in `settings.js` as `publicUrl` and deploy again.
6. **GitHub sign-in app:** github.com/settings/applications/new, with Homepage URL = your address and Authorization callback URL = your address + `/callback`. Then `scripts/set-github.sh` (or `scripts/dialog-github-secret.sh` for the secret in a pop-up) to store the Client ID and a new client secret.
7. **Mailbox passwords:** `scripts/dialog-add.sh all` asks for each mailbox's app password in a Mac pop-up, checks it by reading the 5 newest messages, and stores it in Cloudflare. One mailbox at a time: `scripts/dialog-add.sh <id>`.
8. **Connect Claude:** claude.ai, Settings, Connectors, Add custom connector, address + `/mcp`. Approve, then sign in with GitHub.

Optional: `scripts/install-rules-backup.sh` saves a copy of your sender rules to `backups/` on this Mac every evening.

## Changing things later

- Add or remove a mailbox: edit `settings.js`, `npx wrangler deploy`, then `scripts/dialog-add.sh <id>` for a new one.
- Every change to `settings.js` takes effect after `npx wrangler deploy`.

## Files

- `settings.js`: everything personal. The only file you normally edit.
- `wrangler.jsonc`: Cloudflare settings (Worker name, storage ids, the 15-minute schedule).
- `src/index.js`: sign-in (GitHub) and the 15-minute rule sweep.
- `src/server.js`: the tools Claude sees.
- `src/imap.js`, `src/mail.js`, `src/manage.js`, `src/draft.js`: the mail client, search and read, tidying with undo, drafts.
- `src/rules.js`: sender rules and unsubscribe.
- `src/calendar.js`: iCloud calendar over CalDAV.
- `src/state.js`: storage (rules, undo log) in Cloudflare D1.
- `scripts/`: setup helpers (Mac pop-ups for passwords), a local mailbox check (`node scripts/try.mjs <id>`), and the optional rules backup.
- `test/`: tests (`npm test`) and a local-only tool server.

## Removed from the original

The Google Chat features of the connector this was copied from (reading and posting in Chat, and email alerts about Chat messages) are left out of this version, along with its 5-minute schedule and the Google and Resend sign-ins they needed.
