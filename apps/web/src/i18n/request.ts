import { getRequestConfig } from 'next-intl/server';
import { intlLocale, resolveLocale } from './locale.ts';
import { loadMessages } from './messages.ts';
import { readProfileLocale } from './profile-locale.ts';

// English for everyone until a Market publishes another language (ADR-0002); see ./locale.ts.
export default getRequestConfig(async () => {
  const locale = resolveLocale(await readProfileLocale());
  return {
    locale: intlLocale(locale),
    timeZone: 'UTC',
    messages: await loadMessages(locale),
  };
});
