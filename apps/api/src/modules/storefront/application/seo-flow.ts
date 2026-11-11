import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { ChangeScope, LastChanged } from '../../../platform/audit/change-trail';
import type { StepUpRefusal } from '../../../platform/authz';
import { STOREFRONT_SEO_PROTECTED_STEP_UP } from '../contracts/step-up';
import { StorefrontSeoSettingsChanged } from '../domain/audit';
import { StorefrontSeoIndexingChangedEvent } from '../domain/events';
import {
  changedKeys,
  DEFAULT_SEO_SETTINGS,
  EDIT_KEYS,
  MANAGE_KEYS,
  parseSeoSettings,
  publicSeoOf,
  seoKeyCode,
  seoKeyOfCode,
  touchesManage,
  type FieldError,
  type PublicSeo,
  type SeoSettingKey,
  type SeoSettings,
} from '../domain/seo-settings';
import type { SeoDependencies } from './storefront-dependencies';

// The Market's SEO settings (SEO admin plan, package S1). Each change is a new immutable version in
// `storefront.seo_settings`, an audit row naming the changed fields, and, when the indexing switch
// moved, an outbox event, all in one unit. Changes go live on save (decision 4). A change of a
// manage field (indexing, logo, business details, verification codes, analytics id) also spends a
// fresh admin second factor in that unit and is refused in an acting-as session.

export type SeoFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly SeoFieldError[] }
  /** Another admin saved first; the screen reloads and tries again. `lastChanged` is the winner. */
  | { readonly code: 'storefront.conflict'; readonly lastChanged?: LastChanged | null }
  | { readonly code: 'storefront.seo-version-not-found' }
  /** The admin has no fresh two-step proof for the change: verify one, then repeat. */
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  /** The admin has no active two-step: set it up first. */
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'access.unavailable' };

export interface SeoFieldError {
  readonly path: string;
  readonly code: FieldError['code'] | 'locked';
}

/** What the SEO tab reads. */
export interface SeoSettingsView {
  /** 0 while the code defaults are in force. */
  readonly version: number;
  readonly settings: SeoSettings;
  /** True while the storefront runs on sample data: the indexing switch cannot be turned on. */
  readonly sampleDataLock: boolean;
  /** `off` keeps every page out of the index whatever the switch says. */
  readonly envCeiling: 'on' | 'off';
}

export interface SeoSettingsPage extends SeoSettingsView {
  /** Null while the defaults are in force (never changed). */
  readonly lastChanged: LastChanged | null;
}

/** The audit rows of the SEO settings: the `changed` list names the fields; `after.version` the version. */
export const SEO_SETTINGS_CHANGES: ChangeScope = {
  actions: [StorefrontSeoSettingsChanged.action],
  targetId: 'seo-settings',
  fieldsOf: (row) => {
    const changed = (row.after as { changed?: unknown } | null)?.changed;
    if (!Array.isArray(changed)) return [];
    return changed.flatMap((code) => {
      const key = typeof code === 'string' ? seoKeyOfCode(code) : null;
      return key === null ? [] : [key];
    });
  },
  versionOf: (row) => {
    const version = (row.after as { version?: unknown } | null)?.version;
    return typeof version === 'number' && Number.isSafeInteger(version) ? version : null;
  },
};

/** Fixed namespace of the settings aggregate's id; never change it (consumers key on the id). */
const AGGREGATE_NAMESPACE = 'storefront.seo-settings.v1';

/** The one aggregate id of a Market's SEO settings: the same for every version. */
export function seoAggregateId(market: MarketContext): Id<'SeoSettings'> {
  const bytes = createHash('sha256')
    .update(`${AGGREGATE_NAMESPACE}:${market.marketId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Id<'SeoSettings'>;
}

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

/** Whether the actor is an acting-as session (Login as Seller): the reserved marker on the actor. */
export function isActingAs(context: CallContext): boolean {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

function stepUpFailure(refusal: StepUpRefusal): SeoFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

async function current(
  deps: SeoDependencies,
  market: MarketContext,
): Promise<{ version: number; settings: SeoSettings }> {
  const latest = await deps.seoSettings.latest(market);
  return latest === null
    ? { version: 0, settings: DEFAULT_SEO_SETTINGS }
    : { version: latest.version, settings: latest.settings };
}

function viewOf(
  deps: SeoDependencies,
  market: MarketContext,
  version: number,
  settings: SeoSettings,
): SeoSettingsView {
  return {
    version,
    settings,
    sampleDataLock: deps.seoEnvironment.sampleDataLock(market),
    envCeiling: deps.seoEnvironment.ceiling(market),
  };
}

/** The settings in force: the newest version, else the code defaults. */
export async function viewSeoSettings(
  deps: SeoDependencies,
  context: CallContext,
): Promise<Result<SeoSettingsView, SeoFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<SeoSettingsView, SeoFailure>(
    context.market,
    async () => {
      const { version, settings } = await current(deps, context.market);
      return ok(viewOf(deps, context.market, version, settings));
    },
    { readOnly: true },
  );
}

/** What the buyer site reads without a session: the public fields only. */
export async function viewPublicSeo(
  deps: SeoDependencies,
  context: CallContext,
): Promise<Result<PublicSeo, never>> {
  return deps.unitOfWork.run<PublicSeo, never>(
    context.market,
    async () => {
      const { settings } = await current(deps, context.market);
      return ok(publicSeoOf(settings));
    },
    { readOnly: true },
  );
}

interface Change {
  /** The settings the change leads to, already validated. */
  readonly next: SeoSettings;
  /** Set when the change brings back an older version. */
  readonly restoredFrom: number | null;
}

/**
 * Saves `change` as the next version if the screen saw the current one. The same settings again
 * change nothing (no version, no audit row, no event). A change of a manage field is refused in an
 * acting-as session and spends the admin step-up proof here, after the stale check, so a stale save
 * keeps the proof. `holdsManage` says whether the caller holds `storefront.seo.manage`, for a
 * restore (the protected route's use case checks it by its rule); null when the rule already did.
 */
async function saveChange(
  deps: SeoDependencies,
  context: CallContext,
  expected: number,
  build: (before: SeoSettings) => Promise<Result<Change, SeoFailure>> | Result<Change, SeoFailure>,
  holdsManage: boolean | null,
): Promise<Result<SeoSettingsView, SeoFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run<SeoSettingsView, SeoFailure>(context.market, async () => {
    const { version: currentVersion, settings: before } = await current(deps, context.market);
    // The screen saved from an older version: another admin changed the settings meanwhile.
    if (expected !== currentVersion) return err({ code: 'storefront.conflict' } as const);
    const built = await build(before);
    if (!built.ok) return built;
    const { next, restoredFrom } = built.value;
    const changed = changedKeys(before, next);
    if (changed.length === 0) return ok(viewOf(deps, context.market, currentVersion, before));

    const needsManage = touchesManage(changed);
    if (needsManage) {
      if (isActingAs(context)) return err({ code: 'access.denied' } as const);
      if (holdsManage === false) {
        return err({ code: 'access.denied' } as const);
      }
    }
    // The indexing switch cannot be turned on while the storefront shows sample data.
    if (
      changed.includes('indexing') &&
      next.indexing === 'on' &&
      deps.seoEnvironment.sampleDataLock(context.market)
    ) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'indexing', code: 'locked' }],
      } as const);
    }
    let proof: { sessionId: Id<'Session'>; verifiedAt: Temporal.Instant } | null = null;
    if (needsManage) {
      // The admin step-up, spent here and only here (ADR-0018: authorization in the use case).
      const spent = await deps.stepUp.consume(context, STOREFRONT_SEO_PROTECTED_STEP_UP);
      if (!spent.ok) return err(stepUpFailure(spent.error));
      proof = {
        sessionId: spent.value.sessionId,
        verifiedAt: spent.value.verifiedAt,
      };
    }
    const version = currentVersion + 1;
    const written = await deps.seoSettings.append(context.market, {
      version,
      settings: next,
      changedAt: now,
      changedBy: actor.accountId,
    });
    if (!written) return err({ code: 'storefront.conflict' } as const);
    await deps.audit.record(
      context,
      StorefrontSeoSettingsChanged.entry('seo-settings', {
        before: { version: currentVersion, indexing: before.indexing },
        after: {
          version,
          indexing: next.indexing,
          changed: changed.map(seoKeyCode),
          restoredFrom,
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    if (before.indexing !== next.indexing) {
      await deps.outbox.append(context, [
        StorefrontSeoIndexingChangedEvent.record({
          aggregateId: seoAggregateId(context.market),
          aggregateVersion: version,
          occurredAt: now,
          payload: { version },
        }),
      ]);
    }
    return ok(viewOf(deps, context.market, version, next));
  });
  return done;
}

/** The column is INT4: a larger number can never be a version, and would only reach the database. */
const MAX_VERSION = 2_147_483_647;
const expectedVersionProblem = (expected: unknown): SeoFieldError | null =>
  typeof expected !== 'number' ||
  !Number.isSafeInteger(expected) ||
  expected < 0 ||
  expected > MAX_VERSION
    ? { path: 'expectedVersion', code: 'range' }
    : null;

/** The body keys of a partial save must be exactly the route's keys: no more, no fewer. */
function partOf(
  settings: unknown,
  keys: readonly SeoSettingKey[],
): Result<Record<string, unknown>, readonly SeoFieldError[]> {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return err([{ path: 'settings', code: 'type' }]);
  }
  const given = settings as Record<string, unknown>;
  const problems: SeoFieldError[] = [];
  for (const key of Object.keys(given).sort()) {
    if (!(keys as readonly string[]).includes(key)) {
      const safe = Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�');
      problems.push({ path: `settings.${safe}`, code: 'unknown-field' });
    }
  }
  for (const key of keys) {
    if (given[key] === undefined) problems.push({ path: `settings.${key}`, code: 'required' });
  }
  return problems.length > 0 ? err(problems.slice(0, 20)) : ok(given);
}

/** Replaces the fields of one part (edit or manage) of the settings from the version the screen saw. */
export async function setSeoPart(
  deps: SeoDependencies,
  context: CallContext,
  part: 'edit' | 'manage',
  input: { readonly settings: unknown; readonly expectedVersion: unknown },
): Promise<Result<SeoSettingsView, SeoFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  if (part === 'manage' && isActingAs(context)) return err({ code: 'access.denied' });
  const fields: SeoFieldError[] = [];
  const problem = expectedVersionProblem(input?.expectedVersion);
  if (problem !== null) fields.push(problem);
  const keys: readonly SeoSettingKey[] = part === 'edit' ? EDIT_KEYS : MANAGE_KEYS;
  const given = partOf(input?.settings, keys);
  if (!given.ok) fields.push(...given.error);
  if (fields.length > 0 || !given.ok) return err({ code: 'validation.failed', fields });
  const incoming = given.value;
  const expected = input.expectedVersion as number;

  return saveChange(
    deps,
    context,
    expected,
    (before) => {
      // The other part stays as it is; the whole is checked together, so every bound holds.
      const parsed = parseSeoSettings({ ...before, ...incoming });
      if (!parsed.ok) {
        return err({
          code: 'validation.failed',
          fields: parsed.error.map((e) => ({
            path: keys.includes(e.path.split(/[.[]/u)[0] as SeoSettingKey)
              ? `settings.${e.path}`
              : e.path,
            code: e.code,
          })),
        } as const);
      }
      return ok({ next: parsed.value, restoredFrom: null });
    },
    // The manage route's own rule holds the key; the edit route never changes a protected field,
    // so a save that would (a stored value that normalises differently) is refused, not spent.
    part === 'manage' ? null : false,
  );
}

/** Brings back an older version as a new one. Needs the manage key too when it changes a manage field. */
export async function restoreSeoVersion(
  deps: SeoDependencies,
  context: CallContext,
  input: { readonly version: unknown; readonly expectedVersion: unknown },
): Promise<Result<SeoSettingsView, SeoFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const fields: SeoFieldError[] = [];
  const problem = expectedVersionProblem(input?.expectedVersion);
  if (problem !== null) fields.push(problem);
  const target = input?.version;
  if (
    typeof target !== 'number' ||
    !Number.isSafeInteger(target) ||
    target < 0 ||
    target > MAX_VERSION
  ) {
    fields.push({ path: 'version', code: 'range' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const wanted = target as number;
  // Asked before the unit opens: the gate runs outside it. Only used when the target changes a manage field.
  const manage = (await deps.seoManageProbe.execute(context, {})).ok;

  return saveChange(
    deps,
    context,
    input.expectedVersion as number,
    async (before) => {
      void before;
      const record = wanted === 0 ? null : await deps.seoSettings.find(context.market, wanted);
      if (wanted !== 0 && record === null) {
        return err({ code: 'storefront.seo-version-not-found' } as const);
      }
      return ok({
        next: record === null ? DEFAULT_SEO_SETTINGS : record.settings,
        restoredFrom: wanted,
      });
    },
    manage,
  );
}

export type { PublicSeo };
