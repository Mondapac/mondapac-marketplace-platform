import { storefrontApiConfig } from '../../../src/storefront/config.ts';
import { relaySession } from '../../../src/storefront/session-relay.ts';

export const dynamic = 'force-dynamic';

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return relaySession(storefrontApiConfig(), request, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
