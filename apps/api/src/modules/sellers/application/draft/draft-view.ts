import type { DraftPart, SellerFile } from '../../domain/seller-file';
import type { RegionZones } from '../../domain/zone';

/** The answer of a draft save: what the seller's form needs to move on (sellers design 6.2). */
export interface DraftSaved {
  /** The file's version after the save. */
  readonly version: number;
  readonly draftComplete: boolean;
  /** The mandatory parts still missing, in the order of the form. */
  readonly missing: readonly DraftPart[];
}

export function draftSaved(file: SellerFile): DraftSaved {
  return {
    version: file.state.version,
    draftComplete: file.state.draftComplete,
    missing: file.missing(),
  };
}

/** A request whose fields the domain refused: paths and codes, never values (design 8.3). */
export interface DraftValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/** The file of the seller does not exist yet (it is created from identity's event, 7.5). */
export type FileNotFound = { readonly code: 'file.not-found' };

/** Another save changed the file between this save's read and its write (P 10). */
export type DraftConflict = { readonly code: 'conflict.stale' };

/** Absent, null or only whitespace: "not entered" for an optional field of a save. */
export const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** The zones a seller may choose from for a region, the default first, as the picker shows them. */
export const zoneOptionsOf = (zones: RegionZones | null): readonly string[] =>
  zones === null
    ? []
    : [zones.default, ...zones.selectable.filter((zone) => zone !== zones.default)];
