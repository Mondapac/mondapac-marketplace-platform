import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
export const getTranslations = () =>
  Promise.resolve(createTranslator({ locale: 'en-AU', messages }));
export const getLocale = () => Promise.resolve('en-AU');
export const getTimeZone = () => Promise.resolve('UTC');
