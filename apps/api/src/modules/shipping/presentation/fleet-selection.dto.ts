import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetSelectionModel, FleetSelectionView } from '../domain/fleet-selection';

// Bodies of the fleet-selection routes (delivery models, package 3). Ids, names, whole numbers
// and fleet codes only.

const FLEETS = [
  'mondapac_drive',
  'uber_direct',
  'zoom2u',
  'doordash_drive',
  'auspost',
  'fake_test',
];
const METHODS = ['instant', 'same_day', 'scheduled'];

export class WeightsBody {
  @ApiProperty({ minimum: 0, maximum: 100 }) price!: number;
  @ApiProperty({ minimum: 0, maximum: 100 }) eta!: number;
  @ApiProperty({ minimum: 0, maximum: 100 }) reliability!: number;
}

export class SelectionRuleBody {
  @ApiProperty({ enum: ['cheapest', 'weighted', 'fixed_priority'] }) kind!: string;
  @ApiPropertyOptional({
    type: WeightsBody,
    description: 'weighted only: the weights over price, ETA and reliability (not all zero).',
  })
  weights?: WeightsBody;
  @ApiPropertyOptional({
    enum: FLEETS,
    isArray: true,
    description:
      'fixed_priority only: the fleets in the order tried; a fleet not listed is not used.',
  })
  order?: string[];
}

export class FleetModelBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: SelectionRuleBody }) rule!: SelectionRuleBody;
  @ApiProperty({ description: 'Rises with each edit; send it back as expectedVersion.' })
  version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class FleetStatusBody {
  @ApiProperty({ enum: FLEETS }) fleet!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({
    description: 'False when no adapter is installed or the Market has the fleet off.',
  })
  enabled!: boolean;
  @ApiProperty({ enum: METHODS, isArray: true }) methods!: string[];
  @ApiProperty({ nullable: true, minimum: 0, maximum: 100 }) reliability!: number | null;
  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description: 'The score the router uses: the admin-set one, else the neutral default.',
  })
  effectiveReliability!: number;
}

export class ActiveModelsBody {
  @ApiProperty({ format: 'uuid', nullable: true }) instant!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) same_day!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) scheduled!: string | null;
}

export class FleetSelectionBody {
  @ApiProperty({ type: [FleetModelBody] }) models!: FleetModelBody[];
  @ApiProperty({
    type: ActiveModelsBody,
    description: 'The active model per delivery method; null means the built-in default order.',
  })
  active!: ActiveModelsBody;
  @ApiProperty({ enum: FLEETS, isArray: true, description: 'The built-in default order.' })
  defaultOrder!: string[];
  @ApiProperty({ type: [FleetStatusBody] }) fleets!: FleetStatusBody[];
}

export class FleetModelRequest {
  @ApiProperty({
    description: '1 to 60 letters, digits, spaces and light punctuation; unique per Market.',
  })
  name!: string;
  @ApiProperty({ type: SelectionRuleBody }) rule!: SelectionRuleBody;
}

export class UpdateFleetModelRequest extends FleetModelRequest {
  @ApiProperty({ description: 'The version read; a stale value answers 409.' })
  expectedVersion!: number;
}

export class ActivateModelRequest {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'The model to make active; null puts the built-in default order back.',
  })
  modelId!: string | null;
}

export class ReliabilityRequest {
  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description: 'An admin-set score; a computed one comes later.',
  })
  score!: number;
}

export const modelBody = (model: FleetSelectionModel): FleetModelBody => {
  const { rule } = model;
  return {
    id: model.id,
    name: model.name,
    rule:
      rule.kind === 'cheapest'
        ? { kind: rule.kind }
        : rule.kind === 'weighted'
          ? { kind: rule.kind, weights: { ...rule.weights } }
          : { kind: rule.kind, order: [...rule.order] },
    version: model.version,
    createdAt: model.createdAt.toString(),
    updatedAt: model.updatedAt.toString(),
  };
};

export const selectionBody = (view: FleetSelectionView): FleetSelectionBody => ({
  models: view.models.map(modelBody),
  active: { ...view.active },
  defaultOrder: [...view.defaultOrder],
  fleets: view.fleets.map((fleet) => ({ ...fleet, methods: [...fleet.methods] })),
});
