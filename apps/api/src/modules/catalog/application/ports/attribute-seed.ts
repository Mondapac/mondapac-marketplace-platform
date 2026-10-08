import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  AttributeBounds,
  AttributeOption,
  LocalizedText,
} from '../../domain/attribute-definition';
import type { FamilyGroup } from '../../domain/attribute-family';

export interface SeededDefinition {
  readonly code: string;
  readonly dataType: string;
  readonly localizable: boolean;
  /** ADR-0012 decision 3: set here by people (the seed is reviewed code) or by the editor. */
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly bounds: AttributeBounds;
  readonly names: LocalizedText;
  readonly options: readonly AttributeOption[];
}

export interface SeededFamily {
  readonly code: string;
  readonly groups: readonly FamilyGroup[];
}

/**
 * The versioned seed of attribute definitions and the default family per Market (catalog design
 * 7.2). A Market with no seed file gets empty lists. Definitions are applied before families.
 */
export interface AttributeSeed {
  definitions(market: MarketContext): readonly SeededDefinition[];
  families(market: MarketContext): readonly SeededFamily[];
}

export const ATTRIBUTE_SEED = Symbol('ATTRIBUTE_SEED');
