import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeImpact, AttributeImpactReader } from '../ports/attribute-impact.reader';
import type { AttributeRelaxationStore } from '../ports/attribute-relaxation.store';

/** What the restructure use cases need (attributes A8). */
export interface AttributeRestructureDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeStore: AttributeDefinitionStore;
  readonly relaxations: AttributeRelaxationStore;
  readonly impact: AttributeImpactReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The impact dialog's answer: the attribute as the admin saw it and what a change reaches. */
export interface AttributeImpactView {
  readonly attribute: {
    readonly id: string;
    readonly code: string;
    readonly status: string;
    readonly version: number;
    readonly material: boolean;
    readonly isVariantOption: boolean;
    readonly dataType: string;
  };
  readonly impact: AttributeImpact;
}

export function impactViewOf(
  definition: AttributeDefinition,
  impact: AttributeImpact,
): AttributeImpactView {
  const { id, code, status, version, material, isVariantOption, dataType } = definition.state;
  return {
    attribute: { id, code, status, version, material, isVariantOption, dataType },
    impact,
  };
}

/** Why an archive is refused, in the order the dialog tells it (attributes A8). */
export type ArchiveBlock = 'in-feature-set' | 'live-variants';

/**
 * What stops an archive today: the attribute is still in an active feature set, or it is a
 * variant attribute that live products use. Both are facts of the moment, read inside the unit
 * that holds the attribute's row; a feature set edit may not add an attribute that is not
 * published (the family editor refuses it), so one that starts after the archive is refused there.
 */
export function archiveBlockOf(
  definition: AttributeDefinition,
  impact: AttributeImpact,
): ArchiveBlock | null {
  if (impact.featureSetCount > 0) return 'in-feature-set';
  if (definition.state.isVariantOption && impact.liveVariantProducts.count > 0) {
    return 'live-variants';
  }
  return null;
}
