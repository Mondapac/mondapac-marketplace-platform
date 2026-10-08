import { getRequestConfig } from 'next-intl/server';

// One locale for now (ADR-0033 decision 10); the Market locale will pick it per host.
export default getRequestConfig(async () => ({
  locale: 'en-AU',
  messages: (await import('../../messages/en.json')).default,
}));
