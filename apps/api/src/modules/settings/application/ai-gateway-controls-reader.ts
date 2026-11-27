import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type {
  AiCaps,
  AiGatewayControls,
  AiInHouseControls,
  AiMarketControls,
  AiModelLists,
  InHouseStage,
  InHouseTaskPage,
} from '../../../platform/ai/gateway-controls';
import {
  acceptedValue,
  AI_BUYER_CHAT_CAPABILITY,
  AI_CAP_BUYER_CHAT_DAY_CODE,
  AI_CAP_BUYER_CHAT_MONTH_CODE,
  AI_CAP_CAPABILITY_DAY_CODE,
  AI_CAP_EVALUATION_MONTH_CODE,
  AI_CAP_GUEST_DAY_CODE,
  AI_CAP_MARKET_DAY_CODE,
  AI_CAP_MARKET_MONTH_CODE,
  AI_CAP_NONE,
  AI_CAP_SELLER_DAY_CODE,
  AI_CAPABILITY_SWITCHES,
  AI_GATEWAY_EMERGENCY_STOP_CODE,
  AI_IN_HOUSE_ROLLBACK_ERRORS_CODE,
  AI_IN_HOUSE_ROLLBACK_GUARD_CODE,
  AI_IN_HOUSE_ROLLBACK_SAMPLE_CODE,
  AI_MODEL_TASKS,
  aiInHouseModelCode,
  aiInHouseRolloutCode,
  aiInHouseShadowCode,
  aiInHouseStageCode,
  AI_SAVER_PERCENT_CODE,
  aiModelsCode,
  aiSaverCode,
  capOf,
  familiesOf,
  findDefinition,
} from '../domain/definitions';
import type { MarketSettingRecord } from './ports/market-setting.repository';
import type { SettingsDependencies } from './settings-dependencies';

/**
 * settings' implementation of `platform/ai`'s {@link AiGatewayControls} port (G4; ADR-0042): the
 * Market's AI emergency stop, caps and model lists (G4b), capability switches (G4d3) and in-house model settings (G6b, served from G6c), read for the AI Gateway before each
 * `status` and `run`.
 *
 * Not a use case: the gateway calls it for every actor it serves (a guest, a customer, a seller,
 * an admin, the system actor of an asynchronous capability), the answer does not depend on who
 * asks, and it never leaves the server. It reads the caller's Market only, in a read-only unit of
 * its own, and throws when the store cannot be read (the gateway answers off, ADR-0019 R8). A
 * stored value the definition no longer allows is its restrictive safe value (stop on, cap 0, no
 * list, saver threshold 50 %).
 */
export class SettingsAiGatewayControls implements AiGatewayControls {
  constructor(private readonly deps: Pick<SettingsDependencies, 'unitOfWork' | 'settings'>) {}

  async read(context: CallContext): Promise<AiMarketControls> {
    const rows = await this.deps.unitOfWork.run(
      context.market,
      async () => ok(await this.deps.settings.list(context.market)),
      { readOnly: true },
    );
    if (!rows.ok) throw new Error('settings: the AI Gateway settings could not be read');
    const value = (code: string): string => valueOf(rows.value, code);
    const cap = (code: string): number | null => {
      const stored = value(code);
      return stored === AI_CAP_NONE ? null : (capOf(stored) ?? 0);
    };
    const caps: AiCaps = {
      marketDay: cap(AI_CAP_MARKET_DAY_CODE),
      marketMonth: cap(AI_CAP_MARKET_MONTH_CODE),
      capabilityDay: cap(AI_CAP_CAPABILITY_DAY_CODE),
      sellerDay: cap(AI_CAP_SELLER_DAY_CODE),
      guestDay: cap(AI_CAP_GUEST_DAY_CODE),
      // Never `none` (the definition refuses it); anything else is read as 0 (G4c, fail-closed).
      evaluationMonth: cap(AI_CAP_EVALUATION_MONTH_CODE) ?? 0,
      // The buyer chat's own day and month (G4d2); their defaults cap a Market without a row.
      capabilities: {
        [AI_BUYER_CHAT_CAPABILITY]: {
          day: cap(AI_CAP_BUYER_CHAT_DAY_CODE),
          month: cap(AI_CAP_BUYER_CHAT_MONTH_CODE),
        },
      },
    };
    const lists: Record<string, readonly string[]> = {};
    const savers: Record<string, string> = {};
    for (const task of AI_MODEL_TASKS) {
      const list = familiesOf(value(aiModelsCode(task)));
      if (list.length > 0) lists[task] = list;
      const saver = familiesOf(value(aiSaverCode(task)))[0];
      if (saver !== undefined) savers[task] = saver;
    }
    const models: AiModelLists = {
      lists,
      savers,
      saverAtPercent: Number(value(AI_SAVER_PERCENT_CODE)),
    };
    // The capability switches (G4d3): `on` by default, an invalid stored value is `off`.
    const capabilities: Record<string, boolean> = {};
    for (const [code, capability] of Object.entries(AI_CAPABILITY_SWITCHES)) {
      capabilities[capability] = value(code) === 'on';
    }
    // The in-house model's settings (G6b), as stored in force: the gateway serves them only
    // through inHouseStageInForce and rollbackLimitsInForce (G6c).
    const tasks: Partial<Record<(typeof AI_MODEL_TASKS)[number], InHouseTaskPage>> = {};
    for (const task of AI_MODEL_TASKS) {
      tasks[task] = {
        // The definition allows only the stages, so the value in force is one of them.
        stage: value(aiInHouseStageCode(task)) as InHouseStage,
        family: familiesOf(value(aiInHouseModelCode(task)))[0] ?? null,
        shadowPercent: Number(value(aiInHouseShadowCode(task))),
        rolloutPercent: Number(value(aiInHouseRolloutCode(task))),
      };
    }
    // When an admin last changed each task type's stage, model or percent share (G6d3): an
    // auto-rollback holds the live stage off until a change after it.
    const changedAt = inHouseChangedAt(rows.value);
    const inHouse: AiInHouseControls = {
      tasks,
      changedAt,
      rollback: {
        errorsPermille: Number(value(AI_IN_HOUSE_ROLLBACK_ERRORS_CODE)),
        guardPermille: Number(value(AI_IN_HOUSE_ROLLBACK_GUARD_CODE)),
        minSample: Number(value(AI_IN_HOUSE_ROLLBACK_SAMPLE_CODE)),
      },
    };
    return {
      stopped: value(AI_GATEWAY_EMERGENCY_STOP_CODE) !== 'off',
      caps,
      models,
      capabilities,
      inHouse,
    };
  }
}

/** The value in force: the stored one when its definition allows it, else the safe value. */
function valueOf(rows: readonly MarketSettingRecord[], code: string): string {
  const definition = findDefinition(code)!;
  const row = rows.find((candidate) => candidate.code === code);
  if (row === undefined) return definition.defaultValue;
  return acceptedValue(definition, row.value) ?? definition.safeValue;
}

/**
 * When an admin last changed each task type's in-house stage, model or percent share (G6d3), from
 * the Market's stored settings (a setting still at its default has no time): an auto-rollback holds
 * the task type's live stage off until a change after it. The gateway's controls and the Mondapac
 * Intelligence tab's rollback read (G6e2) both take it from here. A task type never changed is
 * left out.
 */
export function inHouseChangedAt(
  rows: readonly { readonly code: string; readonly updatedAt: Temporal.Instant | null }[],
): Partial<Record<(typeof AI_MODEL_TASKS)[number], Temporal.Instant>> {
  const changedAt: Partial<Record<(typeof AI_MODEL_TASKS)[number], Temporal.Instant>> = {};
  for (const task of AI_MODEL_TASKS) {
    const codes = [aiInHouseStageCode(task), aiInHouseModelCode(task), aiInHouseRolloutCode(task)];
    for (const row of rows) {
      if (row.updatedAt === null || !codes.includes(row.code)) continue;
      const was = changedAt[task];
      if (was === undefined || Temporal.Instant.compare(row.updatedAt, was) > 0) {
        changedAt[task] = row.updatedAt;
      }
    }
  }
  return changedAt;
}
