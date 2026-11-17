import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';

export const getTranslations = (namespace?: string) =>
  Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never }));
