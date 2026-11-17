// A personal mail connector: a remote MCP server that reads and tidies the
// mailboxes listed in settings.js over IMAP. Claude reaches it at /mcp; sign-in
// goes through GitHub and admits only the one GitHub account in settings.js.

import {
  OAuthProvider,
  AuthorizationError,
  CimdFetchError,
  insufficientScope,
  authorizationErrorRedirect,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { createServer } from './server.js';
import { openSocket } from './server.js';
import { autoSweep } from './rules.js';
import { accountsFrom, SETTINGS, MAILBOX_NAMES } from './accounts.js';
import { withAccount } from './mail.js';
import { store } from './state.js';

const SCOPE = 'mail:read';
const MANAGE = 'mail:manage';


const apiHandler = {
  fetch(request, env, ctx) {
    if (!ctx.auth?.scope?.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
    // Hand the granted scopes to the tools, which check mail:manage before changing anything.
    const props = { ...(ctx.props || {}), scopes: ctx.auth.scope };
    return createMcpHandler(createServer, { authContext: { props } })(request, env, ctx);
  },
};

// ---- sign-in: consent page, then GitHub -----------------------------------------------

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body, headers = new Headers(), status = 200) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#5f5e5a;--line:#e3e1db;--accent:#1d1d1b;--warn:#8a4b00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201f;--ink:#efeee9;--muted:#a6a59f;--line:#34332f;--accent:#efeee9;--warn:#f0b56a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:440px;width:100%}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}strong{color:var(--ink)}.warn{color:var(--warn)}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font:inherit;padding:10px 14px;border-radius:9px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.go{background:var(--accent);color:var(--card);border-color:var(--accent)}
</style></head><body><main>${body}</main></body></html>`,
    { status, headers }
  );
}

function consentPage(details, handle) {
  const name = escapeHtml(details.clientName || 'An app');
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app named itself when it registered.';
  const loop = details.redirectIsLoopback
    ? '<p class="warn"><strong>Access goes to an app on this computer.</strong> Continue only if you just started connecting from it.</p>'
    : '';
  return `<h1>Let ${name} read and tidy your email?</h1>
<p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p>It can search and read your ${escapeHtml(MAILBOX_NAMES)} mail, and tidy it: move messages to Trash, archive, file, mark read and star, with an undo log. It can save drafts for you to send${SETTINGS.calendar?.enabled ? ', and read and change your own iCloud calendar' : ''}.</p>
<p>It can't send email or permanently delete anything.</p>
${loop}
<p>Next, GitHub confirms it's you.</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="row"><button name="decision" value="deny">Cancel</button><button class="go" name="decision" value="approve">Continue</button></div></form>`;
}

async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleAuth(request, env) {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const authReq = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      return page('Connect your email', consentPage(details, consent.handle), consent.headers);
    }

    if (url.pathname === '/authorize' && request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE, MANAGE, 'offline_access'] });
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const gh = new URL('https://github.com/login/oauth/authorize');
      gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      gh.searchParams.set('redirect_uri', `${url.origin}/callback`);
      gh.searchParams.set('scope', 'read:user');
      gh.searchParams.set('state', state);
      gh.searchParams.set('code_challenge', await s256(verifier));
      gh.searchParams.set('code_challenge_method', 'S256');
      gh.searchParams.set('allow_signup', 'false');
      // Hand off through a normal page instead of a redirect, so the browser
      // stores the sign-in cookie before GitHub (which may bounce straight
      // back when it remembers you) sends it to /callback.
      const target = escapeHtml(gh.toString());
      const cookieNames = [...headers.entries()].filter(([k]) => k === 'set-cookie').map(([, v]) => v.split('=')[0]);
      console.log(`authorize POST: set cookies ${cookieNames.join(', ')} | ua ${request.headers.get('user-agent')}`);
      headers.set('Cache-Control', 'no-store');
      return page(
        'Confirming with GitHub',
        `<h1>Confirming it's you…</h1><p>Taking you to GitHub.</p>
<meta http-equiv="refresh" content="0;url=${target}">
<div class="row"><a href="${target}"><button class="go" type="button">Continue to GitHub</button></a></div>`,
        headers
      );
    }

    if (url.pathname === '/callback') {
      const sent = (request.headers.get('cookie') || '').split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
      console.log(`callback: cookies ${sent.join(', ') || '(none)'} | ua ${request.headers.get('user-agent')}`);
      const { request: original, data, headers } = await oauth.finishUpstream(request);
      const code = url.searchParams.get('code');
      if (url.searchParams.get('error') || !code) {
        headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
        return new Response(null, { status: 302, headers });
      }
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'janet-mail' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/callback`,
          code_verifier: data.verifier,
        }),
      });
      const token = await tokenRes.json().catch(() => ({ error: `GitHub answered ${tokenRes.status}` }));
      if (!token.access_token) console.log(`GitHub token exchange failed (${tokenRes.status}): ${token.error || ''} ${token.error_description || ''} ${token.message || ''}`);
      if (!token.access_token) return page('Sign-in failed', `<h1>GitHub sign-in failed</h1><p>${escapeHtml(token.error_description || token.error || token.message || 'No token')}</p>`, headers, 400);
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'janet-mail', Accept: 'application/vnd.github+json' },
      });
      const user = await userRes.json();
      const allowed = String(SETTINGS.githubUserId || '').trim();
      if (!/^\d+$/.test(allowed) || String(user.id) !== allowed) {
        console.log(`Refused GitHub user ${user.login} (${user.id})`);
        headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
        return new Response(null, { status: 302, headers });
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: `github-${user.id}`,
        metadata: { login: user.login },
        scope: [...new Set([...original.scope, SCOPE, MANAGE])],
        props: { login: user.login },
      });
      headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/privacy') {
      return page(
        'Privacy',
        `<h1>Privacy</h1><p>This mail connector is a private tool used only by ${escapeHtml(SETTINGS.name || 'its owner')}. It reads their own email${SETTINGS.calendar?.enabled ? ' and calendar' : ''} so Claude can search, summarize and tidy it for them.</p><p>It stores sign-in tokens (encrypted) and a short activity log on Cloudflare. It shares nothing with anyone else and sells nothing.</p>`
      );
    }

    if (url.pathname === '/') {
      return page('Mail connector', '<h1>Mail connector</h1><p>A private email connector for Claude.</p>');
    }
    return new Response('Not found', { status: 404 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return page('Sign-in problem', `<h1>That didn't work</h1><p>${escapeHtml(message)}</p><p>Start connecting again from Claude.</p>`, new Headers(), 400);
    }
    throw error;
  }
}

const PUBLIC_URL = String(SETTINGS.publicUrl || '').replace(/\/+$/, '');

const provider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler,
  defaultHandler: { fetch: handleAuth },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: [SCOPE, MANAGE, 'offline_access'],
  resourceMetadata: {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
  },
  requiredScopes: [SCOPE],
  clientIdMetadataDocumentEnabled: true,
  refreshTokenIdleTTL: 60 * 60 * 24 * 90,
});

// Health notes: when each background job last finished cleanly, and its most recent
// failure (D1 keys health:<job>:ok and health:<job>:fail). D1 writes are cheap (100k/day).
async function beat(env, job, ok, note) {
  const now = new Date().toISOString();
  try {
    if (ok) await store(env).put(`health:${job}:ok`, now);
    else await store(env).put(`health:${job}:fail`, JSON.stringify({ at: now, note: String(note || '').slice(0, 300) }));
  } catch (e) {
    console.log(`health note failed: ${e.message}`);
  }
}

export default {
  fetch: (request, env, ctx) => provider.fetch(request, env, ctx),
  // Runs every 15 minutes (see "triggers" in wrangler.jsonc): apply sender rules.
  async scheduled(event, env, ctx) {
    // Hourly: clear expired rows (confirmations, cached tokens, old log entries) from D1.
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil(store(env).purgeExpired().catch((e) => console.log(`purge failed: ${e.message}`)));
    }
    // Every run: apply the sender rules (block list, keep-list filing) to new inbox mail.
    ctx.waitUntil(
      autoSweep(env, accountsFrom(env), withAccount, openSocket)
        .then((r) => {
          console.log(`rule sweep: ${JSON.stringify(r)}`);
          const failed = Object.entries(r || {}).filter(([, v]) => v && v.error);
          return failed.length
            ? beat(env, 'rule-sweep', false, failed.map(([a, v]) => `${a}: ${v.error}`).join('; '))
            : beat(env, 'rule-sweep', true);
        })
        .catch((e) => {
          console.log(`rule sweep failed: ${e.message}`);
          return beat(env, 'rule-sweep', false, e.message);
        })
    );
  },
};
