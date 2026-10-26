import en from '../../messages/en.json';
import { DEFAULT_LOCALE } from './locale.ts';

type Messages = Record<string, unknown>;

const isTree = (value: unknown): value is Messages =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The catalogue over the English one, key by key: a message not yet translated reads in English. */
function overlay(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isTree(value) && isTree(current) ? overlay(current, value) : value;
  }
  return out;
}

/**
 * The catalogues a Market can publish, by language. A language's `messages/<locale>.json` is added
 * here with its static import when it is translated (W3), e.g.
 * `fa: () => import('../../messages/fa.json')`: the build bundles only what is listed.
 */
const CATALOGUES: Readonly<Record<string, () => Promise<{ default: Messages }>>> = {};

const fromRegistry = async (locale: string): Promise<Messages> => {
  const load = CATALOGUES[locale];
  if (load === undefined) throw new Error(`no catalogue for ${locale}`);
  return (await load()).default;
};

/** The language's catalogue over the English one; English when it has none. */
export async function loadMessages(
  locale: string,
  load: (locale: string) => Promise<Messages> = fromRegistry,
): Promise<Messages> {
  if (locale === DEFAULT_LOCALE) return en;
  try {
    return overlay(en, await load(locale));
  } catch {
    return en;
  }
}
