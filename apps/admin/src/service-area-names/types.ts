// Answers of the admin service area routes (apps/api sellers service-area-names.controller.ts,
// ADR-0041). The list needs `sellers.seller.view`; changing a name needs the edit key.

export const AREAS_VIEW_PERMISSION = 'sellers.seller.view';
export const AREAS_EDIT_PERMISSION = 'sellers.service-area.edit';
export const AREAS_PATH = 'sellers/admin/service-areas';
export const AREA_NAMES_PATH = 'sellers/admin/service-areas/names';
/** The longest name the API accepts. */
export const AREA_NAME_MAX = 120;

export interface AreaLanguageName {
  readonly name: string;
  readonly configuredName: string | null;
  readonly edited: boolean;
}

export interface AreaRow {
  readonly code: string;
  readonly region: string | null;
  readonly sellerOnboardingEnabled: boolean;
  readonly deliveryEnabled: boolean;
  readonly names: Readonly<Record<string, AreaLanguageName>>;
}

export interface AreaNames {
  readonly defaultLanguage: string;
  readonly languages: readonly string[];
  readonly areas: readonly AreaRow[];
}

export interface AreaNamesEdited {
  readonly area: AreaRow;
  readonly changed: number;
}
