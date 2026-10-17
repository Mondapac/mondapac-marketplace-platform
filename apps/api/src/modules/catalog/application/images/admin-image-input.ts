import { parseId } from '@mondapac/shared-kernel';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';

type Parsed<T extends Record<string, string>> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ValidationFailure };

/** The ids of an admin photo request, each parsed or a `validation.failed` naming the field. */
export function parseAdminImageIds<K extends string>(
  input: unknown,
  names: readonly K[],
): Parsed<Record<K, string>> {
  if (typeof input !== 'object' || input === null) return invalid('body', 'type');
  const record = input as Record<string, unknown>;
  const value = {} as Record<K, string>;
  for (const name of names) {
    const raw = record[name];
    const parsed = typeof raw === 'string' ? parseId<string>(raw) : null;
    if (parsed === null || !parsed.ok) return invalid(name, 'format');
    value[name] = parsed.value;
  }
  return { ok: true, value };
}
