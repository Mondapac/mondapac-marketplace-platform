import 'server-only';
import { panelConfig } from './config.ts';
import { serverGet } from './server-fetch.ts';

/**
 * The support address a sign-in page shows: the one an admin set (public read route of the API),
 * else the `PANEL_SUPPORT_EMAIL` value when the API is unreachable or holds none.
 */
export async function supportEmail(): Promise<string> {
  const answer = await serverGet<{ email: string | null }>('notifications/support-contact', {
    anonymous: true,
  });
  if (answer.kind === 'ok' && typeof answer.body.email === 'string' && answer.body.email !== '') {
    return answer.body.email;
  }
  return panelConfig().supportEmail;
}
