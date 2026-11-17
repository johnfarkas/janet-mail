// Local-only entry for checking the MCP tools without sign-in:
//   npx wrangler dev test/dev-worker.js --remote --port 8788 --var DEV_TOOLS:1
// Never deployed (wrangler.jsonc points at src/index.js).
import { createMcpHandler } from 'agents/mcp/server';
import { createServer } from '../src/server.js';


export default {
  fetch(request, env, ctx) {
    if (env.DEV_TOOLS !== '1') return new Response('Local only', { status: 403 });
    // Local testing acts as the owner with full access; this file is never deployed.
    return createMcpHandler(createServer, { authContext: { props: { scopes: ['mail:read', 'mail:manage'] } } })(request, env, ctx);
  },
};
