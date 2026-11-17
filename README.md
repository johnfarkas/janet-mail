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

## Led setup (for the Claude Code session doing it)

You are setting this up for someone who isn't a developer, in the Code tab of their Claude desktop app, opened on their home folder. Run every command yourself. Their part is clicks in a browser or a Mac pop-up: give each as numbered steps, one action each, with what they should see, and wait for "done". Passwords, app passwords and the GitHub client secret go only into the Mac pop-ups the scripts open, never into chat. If they paste a secret into chat, tell them to make a new one and carry on. Their setup chat gave you their mailboxes, GitHub username and time zone; ask for anything missing, one question at a time.

1. **Tools.** Run `node --version` and `git --version`.
   - No Node: they download the LTS installer from nodejs.org, open it and click through (their Mac password goes into the macOS dialog). Check again.
   - No git: macOS offers to install the Command Line Tools; they click Install and wait about five minutes. Check again.
2. **Get the code.** `git clone https://github.com/johnfarkas/janet-mail.git ~/janet-mail`, then work in `~/janet-mail`: `npm install`, then `npm test` (all pass).
3. **Settings.** Fill in `settings.js` yourself from their answers: name, time zone, each mailbox (id, label, host, address, secret name, gmail flag), other addresses, own domains (never a free-mail domain), the iCloud calendar if they have one. Their GitHub ID number: `curl -s https://api.github.com/users/<username>` (the `id` line). Show them the mailbox list and ask them to confirm it.
4. **Cloudflare sign-in.** Run `npx wrangler login`. A browser page opens: they click **Allow**. You should see "Successfully logged in".
5. **workers.dev address.** A new Cloudflare account needs one before the first deploy. They open dash.cloudflare.com → Workers & Pages; if asked to choose a subdomain, they pick one (their name works) and confirm.
6. **Storage.** `scripts/setup-cloudflare.sh`. You should see "KV ready" and "Database ready". If it can't read an id, put the ids from wrangler's output into `wrangler.jsonc` by hand.
7. **First deploy.** `npx wrangler deploy`. Copy the address it prints into `settings.js` as `publicUrl`, then deploy again.
8. **GitHub sign-in app.** They open github.com/settings/applications/new and fill in: Application name `My mail connector`; Homepage URL = the address; Authorization callback URL = the address + `/callback`. They click **Register application**, then **Generate a new client secret**, and keep that page open. They paste the **Client ID** (public, fine in chat) to you; store it with `printf '%s' '<client id>' | npx wrangler secret put GITHUB_CLIENT_ID`. Then run `scripts/dialog-github-secret.sh`: a pop-up appears and they paste the **client secret** there. You should see "GitHub secret saved".
9. **Mailboxes.** They have each app password ready (their setup chat led them to make them). Run `scripts/dialog-add.sh all`: one pop-up per mailbox, they paste that mailbox's app password. Each should end with "connected". A failure usually means a mistyped password or two-step sign-in off; fix and rerun `scripts/dialog-add.sh <id>`.
10. **Deploy** once more: `npx wrangler deploy`.
11. **Connect Claude.** In the Claude app: Settings → Connectors → Add custom connector. Name it `My mail`; URL = the address + `/mcp`. They click Connect, approve, and sign in with GitHub. Then, in a new chat, ask Claude to list the mail accounts: every mailbox should be there.
12. **Report back.** Tell them it's done, give them the connector's name and address, and tell them to go back to their setup chat and say "mail is connected".

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
