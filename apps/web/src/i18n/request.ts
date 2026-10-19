import { getRequestConfig } from 'next-intl/server';

// One English catalogue until a Market needs another language (ADR-0002). Prices carry their own
// currency and are formatted in this locale.
export default getRequestConfig(async () => ({
  locale: 'en',
  timeZone: 'UTC',
  messages: (await import('../../messages/en.json')).default,
}));
