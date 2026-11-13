import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_SETTINGS_EDIT } from '../../contracts/permissions';
import { AiAccessChanged } from '../../domain/audit';
import type { AiAccessSettingRepository } from '../ports/ai-access-setting.repository';

/** The seller from the path and the body as it came: `{ enabled }`. */
export interface ChangeAiAccessInput {
  readonly sellerId?: unknown;
  readonly body?: unknown;
}

export interface ChangeAiAccessResult {
  readonly enabled: boolean;
  /**
   * False when the switch already held the value: no audit row (the row lock still
   * raised the settings row's version).
   */
  readonly changed: boolean;
}

export type ChangeAiAccessFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    };

export interface ChangeAiAccessDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly aiAccessSetting: AiAccessSettingRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const BODY_KEYS = ['enabled'] as const;

/**
 * `sellers.change-ai-access` (SEL-25; ADR-0019 decision 7): an admin switches AI on or off for one
 * seller. Rule `permissions [sellers.seller-settings.edit]` (platform scope, not protected); admin
 * population only. One read-write unit: the settings row is locked by a version bump, the switch is
 * set with who and when and the audit row `sellers.ai-access.changed` is written. No outbox event:
 * `platform/ai` reads the switch at use time through the `aiAccessOf` facade, nothing consumes a
 * change. A repeat of the value already held is `changed: false` with no audit row. An unknown
 * seller and another Market's seller are both `file.not-found`. The session carries no acting-as
 * marker yet (as for SEL-26 and every sellers write), so the refusal of an acting-as session
 * follows with the acting-as slice (ADR-0019 R3: no AI in an acting-as session).
 */
export class ChangeAiAccessUseCase extends UseCase<
  ChangeAiAccessInput,
  ChangeAiAccessResult,
  ChangeAiAccessFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.change-ai-access',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_SETTINGS_EDIT.key] },
  };

  readonly #logger = new Logger('ChangeAiAccess');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeAiAccessDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangeAiAccessInput,
  ): Promise<Result<ChangeAiAccessResult, ChangeAiAccessFailure>> {
    const result = await this.change(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.change-ai-access',
      code: result.ok ? (result.value.changed ? 'changed' : 'unchanged') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async change(
    context: CallContext,
    input: ChangeAiAccessInput,
  ): Promise<Result<ChangeAiAccessResult, ChangeAiAccessFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;

    const body = input.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return err({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
    }
    const fields: { path: string; code: string }[] = [];
    for (const key of Object.keys(body).sort()) {
      if (!(BODY_KEYS as readonly string[]).includes(key)) {
        fields.push({ path: key.slice(0, 64), code: 'unknown-field' });
      }
    }
    const { enabled } = body as Record<string, unknown>;
    if (typeof enabled !== 'boolean') {
      fields.push({ path: 'enabled', code: enabled === undefined ? 'required' : 'type' });
    }
    if (fields.length > 0 || typeof enabled !== 'boolean') {
      return err({ code: 'validation.failed', fields });
    }

    const { unitOfWork, aiAccessSetting, audit, clock } = this.deps;
    return unitOfWork.run<ChangeAiAccessResult, ChangeAiAccessFailure>(market, async () => {
      const state = await aiAccessSetting.lock(market, sellerId);
      if (state === null) return err({ code: 'file.not-found' });
      if (state.enabled === enabled) return ok({ enabled, changed: false });
      const now = clock.now();
      await aiAccessSetting.set(market, sellerId, {
        enabled,
        by: actor.accountId,
        at: now,
      });
      await audit.record(
        context,
        AiAccessChanged.entry(sellerId, {
          before: { enabled: state.enabled },
          after: { enabled: enabled },
        }),
      );
      return ok({ enabled, changed: true });
    });
  }
}
