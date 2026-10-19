import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  DEFAULT_ASSISTANT_SETTINGS,
  inRollout,
  MODEL_TIERS,
  parseAssistantSettings,
  sameSettings,
  UNAVAILABLE_OPTIONS,
  type AssistantSettings,
  type FieldError,
  type ModelTier,
  type ReplyLanguage,
} from '../domain/assistant-settings';
import { AssistantSettingsChanged } from '../domain/audit';
import type { AssistantDependencies } from './assistant-dependencies';

export type AssistantSettingsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  /** Another admin changed the settings first; the screen reloads and tries again. */
  | { readonly code: 'assistant.conflict' };

/** What the admin settings screen reads. The API key is reported as set or not, never shown. */
export interface AssistantSettingsView {
  /** 0 while the built-in defaults are in force. */
  readonly version: number;
  readonly settings: AssistantSettings;
  readonly apiKey: 'set' | 'not-set';
  /** The provider model configured for each tier (server configuration; null when none). */
  readonly models: readonly { readonly tier: ModelTier; readonly modelId: string | null }[];
  /** Options the screen shows disabled, with a reason, because they are not built yet. */
  readonly unavailableOptions: typeof UNAVAILABLE_OPTIONS;
}

/** What the storefront may read without a session: the safe subset only. */
export interface StorefrontAssistantView {
  /** Switched on, configured, and this visitor is in the rollout. */
  readonly enabled: boolean;
  /** A guest may chat; when false the widget asks a guest to sign in. */
  readonly guestsAllowed: boolean;
  readonly replyLanguage: ReplyLanguage;
  /** null: the storefront shows its own default text. */
  readonly welcomeText: string | null;
}

const OFF: StorefrontAssistantView = Object.freeze({
  enabled: false,
  guestsAllowed: false,
  replyLanguage: DEFAULT_ASSISTANT_SETTINGS.replyLanguage,
  welcomeText: null,
});

// The key a storefront visitor sends to keep one rollout bucket (the widget's random id).
const VISITOR_KEY = /^[A-Za-z0-9_-]{16,64}$/;

const RETENTION_DAYS = { none: 0, '30-days': 30, '12-months': 365 } as const;

function auditSnapshot(version: number, settings: AssistantSettings) {
  return {
    version,
    enabled: settings.enabled,
    users: settings.users,
    retentionDays: RETENTION_DAYS[settings.retention],
    dailySpendCapUsdCents: settings.dailySpendCapUsdCents,
    monthlySpendCapUsdCents: settings.monthlySpendCapUsdCents,
  };
}

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

function viewOf(
  deps: AssistantDependencies,
  version: number,
  settings: AssistantSettings,
): AssistantSettingsView {
  return {
    version,
    settings,
    apiKey: deps.runtime.apiKeyConfigured() ? 'set' : 'not-set',
    models: MODEL_TIERS.map((tier) => ({ tier, modelId: deps.runtime.modelOf(tier) })),
    unavailableOptions: UNAVAILABLE_OPTIONS,
  };
}

async function current(
  deps: AssistantDependencies,
  context: CallContext,
): Promise<{ version: number; settings: AssistantSettings }> {
  const latest = await deps.settings.latest(context.market);
  return latest === null
    ? { version: 0, settings: DEFAULT_ASSISTANT_SETTINGS }
    : { version: latest.version, settings: latest.settings };
}

/** The settings in force: the newest admin version, else the built-in defaults. */
export async function viewAssistantSettings(
  deps: AssistantDependencies,
  context: CallContext,
): Promise<Result<AssistantSettingsView, AssistantSettingsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<AssistantSettingsView, AssistantSettingsFailure>(
    context.market,
    async () => {
      const { version, settings } = await current(deps, context);
      return ok(viewOf(deps, version, settings));
    },
    { readOnly: true },
  );
}

/** An admin replaces the settings from the version they saw; each change is a new version, audited. */
export async function setAssistantSettings(
  deps: AssistantDependencies,
  context: CallContext,
  input: { readonly settings: unknown; readonly expectedVersion: unknown },
): Promise<Result<AssistantSettingsView, AssistantSettingsFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const expected = input?.expectedVersion;
  const fields: FieldError[] = [];
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
    fields.push({ path: 'expectedVersion', code: 'range' });
  }
  const parsed = parseAssistantSettings(input?.settings);
  if (!parsed.ok) fields.push(...parsed.error);
  if (fields.length > 0 || !parsed.ok) return err({ code: 'validation.failed', fields });
  const next = parsed.value;

  const now = deps.clock.now();
  return deps.unitOfWork.run<AssistantSettingsView, AssistantSettingsFailure>(
    context.market,
    async () => {
      const { version: currentVersion, settings: before } = await current(deps, context);
      // The screen saved from an older version: another admin changed the settings meanwhile.
      if (expected !== currentVersion) return err({ code: 'assistant.conflict' } as const);
      // The same settings again change nothing: no new version, no audit row.
      if (sameSettings(before, next)) return ok(viewOf(deps, currentVersion, before));

      const version = currentVersion + 1;
      const written = await deps.settings.append(context.market, {
        version,
        settings: next,
        changedAt: now,
        changedBy: actor.accountId,
      });
      if (!written) return err({ code: 'assistant.conflict' } as const);
      await deps.audit.record(
        context,
        AssistantSettingsChanged.entry('assistant-settings', {
          before: auditSnapshot(currentVersion, before),
          after: auditSnapshot(version, next),
        }),
      );
      return ok(viewOf(deps, version, next));
    },
  );
}

/**
 * The storefront's view for one visitor, read without a session. The widget sends its own random
 * visitor key so one browser keeps one rollout bucket; an unusable key counts as none. Off,
 * unconfigured or outside the rollout, the answer says only `enabled: false`.
 */
export async function viewStorefrontAssistant(
  deps: AssistantDependencies,
  context: CallContext,
  input: { readonly visitor: unknown },
): Promise<Result<StorefrontAssistantView, never>> {
  const visitorKey =
    typeof input?.visitor === 'string' && VISITOR_KEY.test(input.visitor) ? input.visitor : null;
  return deps.unitOfWork.run<StorefrontAssistantView, never>(
    context.market,
    async () => {
      const { settings } = await current(deps, context);
      const configured =
        deps.runtime.apiKeyConfigured() && deps.runtime.modelOf(settings.modelTier) !== null;
      if (!configured || !inRollout(settings, context.market.marketId, visitorKey)) return ok(OFF);
      return ok({
        enabled: true,
        guestsAllowed: settings.users === 'guests-and-customers',
        replyLanguage: settings.replyLanguage,
        welcomeText: settings.welcomeText,
      });
    },
    { readOnly: true },
  );
}
