import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  AI_DESCRIPTION_WRITER_CODE,
  AI_DESCRIPTION_WRITER_TIER_CODE,
  type AiModelTierSetting,
} from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { readSettingValue } from '../settings-flow';

export interface AiDescriptionWriterSetting {
  readonly enabled: boolean;
  readonly tier: AiModelTierSetting;
}

/**
 * `settings.read-ai-description-writer`: whether the AI description writer is on in the Market,
 * and on which model tier, for `catalog` through the settings facade. Any signed-in panel user
 * reads it (the writer is offered to sellers and admins). Only the stored value `on` is on: a
 * missing row, an unreadable store or any other value is off (ADR-0019 R8, ADR-0026 decision 5).
 */
export class ReadAiDescriptionWriter extends UseCase<
  Record<string, never>,
  AiDescriptionWriterSetting,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.read-ai-description-writer',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<AiDescriptionWriterSetting, never>> {
    const enabled = await readSettingValue(this.deps, context, AI_DESCRIPTION_WRITER_CODE);
    const tier = await readSettingValue(this.deps, context, AI_DESCRIPTION_WRITER_TIER_CODE);
    return ok({ enabled: enabled === 'on', tier: tier === 'balanced' ? 'balanced' : 'fast' });
  }
}
