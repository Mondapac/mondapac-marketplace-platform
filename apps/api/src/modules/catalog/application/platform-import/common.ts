import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';

// What the platform import use cases share (catalog design 14a).

export type ImportCommonFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'import.not-found' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export const importIdOf = (value: unknown): Id<'PlatformImport'> | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'PlatformImport'>(value);
  return parsed.ok ? parsed.value : null;
};

export const EMPTY_PARTS = { errorRows: [], failedRows: [], previewRows: [] } as const;
