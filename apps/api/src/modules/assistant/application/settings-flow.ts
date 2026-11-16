import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { isPlatformAdminActor } from '../../../platform/authz';
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
import { retentionDaysOf } from '../domain/conversation';
import { AssistantPreviewTokenIssued, AssistantSettingsChanged } from '../domain/audit';
import type { ChangeScope, LastChanged } from '../../../platform/audit/change-trail';
import type { AssistantDependencies } from './assistant-dependencies';

export type AssistantSettingsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  /**
   * Another admin changed the settings first; the screen reloads and tries again. `lastChanged`
   * is the winning save, null when it cannot be read.
   */
  | { readonly code: 'assistant.conflict'; readonly lastChanged?: LastChanged | null };

export type PreviewTokenFailure =
  | { readonly code: 'access.denied' }
  /** No signing key is configured on this server: the preview is off. */
  | { readonly code: 'assistant.preview-unavailable' };

/** A new internal preview token; the admin panel hands it to the storefront, never stores it. */
export interface PreviewTokenView {
  readonly token: string;
  /** ISO 8601 instant (UTC). */
  readonly expiresAt: string;
}

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
  /**
   * Read-only figures for the tab (plan section 11): spend today and this month in micro US
   * dollars (the caps are in cents), conversations started today, and the last time a cap
   * switched the assistant off. Days are the Market's own calendar.
   */
  readonly spend: {
    readonly todayMicroUsd: number;
    readonly monthMicroUsd: number;
    readonly conversationsToday: number;
    readonly lastAutoOff: { readonly at: string; readonly cap: 'daily' | 'monthly' } | null;
  };
}

/** The settings page's read model: the view and the latest change. */
export interface AssistantSettingsPage extends AssistantSettingsView {
  /** Null while the built-in defaults are in force (never changed). */
  readonly lastChanged: LastChanged | null;
}

/** The audit rows of the settings page: the fields the row names are the changed ones. */
export const ASSISTANT_SETTINGS_CHANGES: ChangeScope = {
  actions: [AssistantSettingsChanged.action],
  targetId: 'assistant-settings',
};

/** What the storefront may read without a session: the safe subset only. */
export interface StorefrontAssistantView {
  /** Switched on, configured, and this visitor is in the rollout. */
  readonly enabled: boolean;
  /** A guest may chat; when false the widget asks a guest to sign in. */
  readonly guestsAllowed: boolean;
  readonly replyLanguage: ReplyLanguage;
  /** null: the storefront shows its own default text. */
  readonly welcomeText: string | null;
  /**
   * How many days a new conversation is kept (0: not kept), so the widget can say so: for a
   * signed-in customer and for a guest (30 at most). The answer reads no session, so it gives
   * both. null while off for this visitor.
   */
  readonly retentionDays: { readonly customer: number; readonly guest: number } | null;
  /** Fixed button texts in the buyer's language; empty while off for this visitor. */
  readonly quickPrompts: readonly string[];
  /**
   * The browser sent a valid internal preview token: the widget marks itself as a preview. False
   * for every other visitor, and while the assistant is off.
   */
  readonly preview: boolean;
}

export const STOREFRONT_OFF: StorefrontAssistantView = Object.freeze({
  enabled: false,
  guestsAllowed: false,
  replyLanguage: DEFAULT_ASSISTANT_SETTINGS.replyLanguage,
  welcomeText: null,
  retentionDays: null,
  quickPrompts: Object.freeze([]),
  preview: false,
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

async function viewOf(
  deps: AssistantDependencies,
  context: CallContext,
  version: number,
  settings: AssistantSettings,
): Promise<AssistantSettingsView> {
  const { marketId } = context.market;
  const totals = await deps.spend.totals(
    context.market,
    deps.calendar.dayOf(context.market, deps.clock.now()),
  );
  return {
    version,
    settings,
    apiKey: deps.runtime.apiKeyConfigured(marketId) ? 'set' : 'not-set',
    models: MODEL_TIERS.map((tier) => ({ tier, modelId: deps.runtime.modelOf(marketId, tier) })),
    unavailableOptions: UNAVAILABLE_OPTIONS,
    spend: {
      todayMicroUsd: totals.todayMicroUsd,
      monthMicroUsd: totals.monthMicroUsd,
      conversationsToday: totals.conversationsToday,
      lastAutoOff:
        totals.lastAutoOff === null
          ? null
          : { at: totals.lastAutoOff.at.toString(), cap: totals.lastAutoOff.cap },
    },
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
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<AssistantSettingsView, AssistantSettingsFailure>(
    context.market,
    async () => {
      const { version, settings } = await current(deps, context);
      return ok(await viewOf(deps, context, version, settings));
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
      if (sameSettings(before, next))
        return ok(await viewOf(deps, context, currentVersion, before));

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
      return ok(await viewOf(deps, context, version, next));
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
  input: { readonly visitor: unknown; readonly lang?: unknown; readonly preview?: unknown },
): Promise<Result<StorefrontAssistantView, never>> {
  const lang = typeof input?.lang === 'string' ? input.lang : null;
  const preview =
    input?.preview !== undefined &&
    deps.previewTokens.verify(context.market, input.preview, deps.clock.now());
  const visitorKey =
    typeof input?.visitor === 'string' && VISITOR_KEY.test(input.visitor) ? input.visitor : null;
  return deps.unitOfWork.run<StorefrontAssistantView, never>(
    context.market,
    async () => {
      const { settings } = await current(deps, context);
      const configured = deps.runtime.configured(context.market.marketId, settings.modelTier);
      if (!configured || !inRollout(settings, context.market.marketId, visitorKey, preview)) {
        return ok(STOREFRONT_OFF);
      }
      return ok({
        enabled: true,
        guestsAllowed: settings.users === 'guests-and-customers',
        replyLanguage: settings.replyLanguage,
        welcomeText: settings.welcomeText,
        retentionDays: {
          customer: retentionDaysOf(settings.retention, 'customer'),
          guest: retentionDaysOf(settings.retention, 'guest'),
        },
        quickPrompts: deps.quickPrompts.forBuyer(context.market, lang),
        preview,
      });
    },
    { readOnly: true },
  );
}

/**
 * An admin with `assistant.settings.manage` takes an internal preview token (stage 0, B4): the
 * storefront sends it with the read and each message, and the assistant then answers that browser
 * while the audience is `internal` (never past the kill switch, a missing model or a spend cap).
 * Valid 30 minutes, for this Market only; each issue is an audit row naming the expiry, never the
 * token. No key configured: `assistant.preview-unavailable`.
 */
export async function issuePreviewToken(
  deps: AssistantDependencies,
  context: CallContext,
): Promise<Result<PreviewTokenView, PreviewTokenFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  if (!deps.previewTokens.available()) return err({ code: 'assistant.preview-unavailable' });
  const issued = deps.previewTokens.issue(context.market, deps.clock.now());
  if (issued === null) return err({ code: 'assistant.preview-unavailable' });
  return deps.unitOfWork.run<PreviewTokenView, PreviewTokenFailure>(context.market, async () => {
    await deps.audit.record(
      context,
      AssistantPreviewTokenIssued.entry('assistant-settings', {
        after: { expiresAt: issued.expiresAt },
      }),
    );
    return ok({ token: issued.token, expiresAt: issued.expiresAt.toString() });
  });
}
