// ============================================================================
//  YOUR SETTINGS
//  Everything personal about this mail connector lives in this one file.
//  Replace every placeholder (the parts that say "you", "example" or "YOUR")
//  with your own details, save, and deploy. Passwords never go in this file:
//  each mailbox's app password is stored separately as a Cloudflare secret.
// ============================================================================

export default {
  // Your name, as it should appear on the "From" line of drafts.
  name: 'Your Name',

  // The web address of your connector once it's deployed. The setup steps
  // tell you what it is; it ends in .workers.dev. No slash at the end.
  publicUrl: 'https://janet-mail.YOUR-SUBDOMAIN.workers.dev',

  // Your GitHub account's ID number (a number, not your username). Only this
  // GitHub account can connect to your mail. Find it at
  // https://api.github.com/users/YOUR-GITHUB-USERNAME (the "id" line).
  githubUserId: 'YOUR-GITHUB-ID-NUMBER',

  // Your time zone, for calendar times. Examples: 'America/New_York',
  // 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London'.
  timeZone: 'America/New_York',

  // The mailboxes Claude can read and tidy. Add one block per mailbox, or
  // delete the ones you don't have. For each one:
  //   id      a short one-word nickname, lowercase, no spaces (e.g. 'work')
  //   label   how it's described to Claude (e.g. 'Work Gmail')
  //   host    the mail server: 'imap.gmail.com' for Gmail and Google Workspace,
  //           'imap.mail.me.com' for iCloud
  //   port    leave at 993
  //   user    the full email address
  //   secret  the name its app password is stored under: CAPITALS and
  //           underscores, ending in _APP_PASSWORD, different for each mailbox
  //   gmail   true for Gmail / Google Workspace, false for anything else
  mailboxes: [
    {
      id: 'icloud',
      label: 'iCloud',
      host: 'imap.mail.me.com',
      port: 993,
      user: 'you@icloud.com',
      secret: 'ICLOUD_APP_PASSWORD',
      gmail: false,
    },
    {
      id: 'gmail',
      label: 'Gmail',
      host: 'imap.gmail.com',
      port: 993,
      user: 'you@gmail.com',
      secret: 'GMAIL_APP_PASSWORD',
      gmail: true,
    },
  ],

  // Any other addresses of yours that deliver into the mailboxes above
  // (aliases, old addresses that forward). Used so replies never go back to
  // you. Leave the list empty, [], if you have none.
  otherAddresses: ['you@example.com'],

  // Your own web domains, if you have any (e.g. 'yourcompany.com'). Claude
  // won't block or file a whole domain listed here, only exact addresses.
  // Leave empty, [], if you have none.
  ownDomains: ['example.com'],

  // Your iCloud calendar. Set enabled to false if you don't use iCloud
  // Calendar; the calendar tools then disappear.
  calendar: {
    enabled: true,
    // The iCloud address you sign in to iCloud with.
    user: 'you@icloud.com',
    // Which stored password to use: the same one as your iCloud mailbox above.
    secret: 'ICLOUD_APP_PASSWORD',
    // The names of the calendars Claude may see and change, exactly as they
    // appear in the Calendar app. Calendars not listed stay out of reach.
    calendarNames: ['Home'],
  },
};
