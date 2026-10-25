import { getRequestConfig } from 'next-intl/server';
import { intlLocale, resolveLocale } from './locale.ts';
import { loadMessages } from './messages.ts';

/**
 * The signed-in buyer's language, or null. The profile field arrives with the buyer account's
 * language setting (W5); until then the customer session carries no locale, so this is null and
 * every request is English.
 */
async function profileLocale(): Promise<string | null> {
  return Promise.resolve(null);
}

// English for everyone until a Market publishes another language (ADR-0002); see ./locale.ts.
export default getRequestConfig(async () => {
  const locale = resolveLocale(await profileLocale());
  return {
    locale: intlLocale(locale),
    timeZone: 'UTC',
    messages: await loadMessages(locale),
  };
});
