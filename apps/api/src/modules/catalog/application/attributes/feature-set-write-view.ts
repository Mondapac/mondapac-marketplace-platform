import type { AttributeFamily } from '../../domain/attribute-family';

/** What a feature-set write answers: enough for the panel to re-read it and keep its version. */
export interface FeatureSetWriteView {
  readonly id: string;
  readonly code: string;
  readonly status: 'active' | 'archived';
  readonly version: number;
  readonly revisionNo: number;
}

export function featureSetWriteViewOf(family: AttributeFamily): FeatureSetWriteView {
  const { id, code, status, version, revisionNo } = family.state;
  return { id, code, status, version, revisionNo };
}
