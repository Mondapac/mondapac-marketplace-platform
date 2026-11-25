import { ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type {
  AiCaps,
  AiGatewayControls,
  AiMarketControls,
} from '../../../platform/ai/gateway-controls';
import {
  acceptedValue,
  AI_CAP_CAPABILITY_DAY_CODE,
  AI_CAP_GUEST_DAY_CODE,
  AI_CAP_MARKET_DAY_CODE,
  AI_CAP_MARKET_MONTH_CODE,
  AI_CAP_NONE,
  AI_CAP_SELLER_DAY_CODE,
  AI_GATEWAY_EMERGENCY_STOP_CODE,
  capOf,
  findDefinition,
} from '../domain/definitions';
import type { MarketSettingRecord } from './ports/market-setting.repository';
import type { SettingsDependencies } from './settings-dependencies';

/**
 * settings' implementation of `platform/ai`'s {@link AiGatewayControls} port (G4; ADR-0042): the
 * Market's AI emergency stop and caps, read for the AI Gateway before each `status` and `run`.
 *
 * Not a use case: the gateway calls it for every actor it serves (a guest, a customer, a seller,
 * an admin, the system actor of an asynchronous capability), the answer does not depend on who
 * asks, and it never leaves the server. It reads the caller's Market only, in a read-only unit of
 * its own, and throws when the store cannot be read (the gateway answers off, ADR-0019 R8). A
 * stored value the definition no longer allows is its restrictive safe value (stop on, cap 0).
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
    };
    return { stopped: value(AI_GATEWAY_EMERGENCY_STOP_CODE) !== 'off', caps };
  }
}

/** The value in force: the stored one when its definition allows it, else the safe value. */
function valueOf(rows: readonly MarketSettingRecord[], code: string): string {
  const definition = findDefinition(code)!;
  const row = rows.find((candidate) => candidate.code === code);
  if (row === undefined) return definition.defaultValue;
  return acceptedValue(definition, row.value) ?? definition.safeValue;
}
