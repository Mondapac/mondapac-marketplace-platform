import { storefrontApiConfig } from '../../../src/storefront/config.ts';
import { relay } from '../../../src/storefront/bff.ts';

export const dynamic = 'force-dynamic';

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return relay(storefrontApiConfig(), request, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
