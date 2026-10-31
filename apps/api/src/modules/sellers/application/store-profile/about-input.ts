import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { parseAboutText } from '../../domain/store-about';
import type { StoreTextClaimCheck } from '../ports/store-text-claim-check';
import type { StoreProfileWriteFailure } from './store-profile';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The texts by locale, each parsed. A shape or locale problem names its path; a text problem
 * names the locale path and the rule. The locale keys are the Market's, so a path never echoes
 * the client's own spelling. Shared by the About save and the whole-profile save.
 */
export function parseAboutTexts(
  about: unknown,
  supported: readonly string[],
): Result<ReadonlyMap<string, string>, StoreProfileWriteFailure> {
  if (!isRecord(about)) {
    return err({ code: 'validation.failed', fields: [{ path: 'about', code: 'type' }] });
  }
  const fields: { path: string; code: string }[] = [];
  const texts = new Map<string, string>();
  if (Object.keys(about).some((locale) => !supported.includes(locale))) {
    fields.push({ path: 'about', code: 'locale' });
  }
  for (const locale of supported) {
    if (!Object.hasOwn(about, locale)) continue;
    const parsed = parseAboutText(about[locale]);
    if (!parsed.ok) {
      fields.push({ path: `about.${locale}`, code: parsed.error.rule });
      continue;
    }
    if (parsed.value !== '') texts.set(locale, parsed.value);
  }
  return fields.length > 0 ? err({ code: 'validation.failed', fields }) : ok(texts);
}

/** The locales whose text asserts a certification: `about.<locale>` with `claim-term`. Fail closed. */
export async function claimFieldsOf(
  claimCheck: StoreTextClaimCheck,
  context: CallContext,
  texts: ReadonlyMap<string, string>,
): Promise<Result<{ path: string; code: string }[], StoreProfileWriteFailure>> {
  const entries = [...texts].map(([locale, text]) => ({ locale, text }));
  if (entries.length === 0) return ok([]);
  const flags = await claimCheck.flagged(context, entries);
  if (!flags.ok) return err({ code: 'sellers.unavailable' });
  return ok(
    entries.flatMap((entry, index) =>
      flags.value[index] === true ? [{ path: `about.${entry.locale}`, code: 'claim-term' }] : [],
    ),
  );
}
