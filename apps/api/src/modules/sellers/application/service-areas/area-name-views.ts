import type { ConfiguredArea } from '../ports/seller-market-formats';
import type { EditedNamesByArea } from '../ports/service-area-names.repository';

/** The name of an area in one language: what shows, what the configuration holds, whether edited. */
export interface AreaLanguageName {
  readonly name: string;
  /** The configured name; null when the configuration has none for this language. */
  readonly configuredName: string | null;
  readonly edited: boolean;
}

export interface ServiceAreaNamesRow {
  readonly code: string;
  readonly region: string | null;
  readonly sellerOnboardingEnabled: boolean;
  readonly deliveryEnabled: boolean;
  /** Only the languages that have a name (configured or edited). */
  readonly names: Readonly<Record<string, AreaLanguageName>>;
}

export function rowOfArea(
  area: ConfiguredArea,
  edited: EditedNamesByArea,
  languages: readonly string[],
): ServiceAreaNamesRow {
  const mine = edited.get(area.code) ?? {};
  const names: Record<string, AreaLanguageName> = {};
  for (const locale of languages) {
    const configuredName = area.names[locale] ?? null;
    const editedName = mine[locale];
    const name = editedName ?? configuredName;
    if (name === undefined || name === null) continue;
    names[locale] = { name, configuredName, edited: editedName !== undefined };
  }
  return {
    code: area.code,
    region: area.region,
    sellerOnboardingEnabled: area.sellerOnboardingEnabled,
    deliveryEnabled: area.deliveryEnabled,
    names,
  };
}
