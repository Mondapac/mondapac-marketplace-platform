import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { LocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import type { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type {
  ComposedMail,
  IdentityMail,
  IdentityMailComposer,
} from '../../application/ports/identity-mails';

/** Every key the `identity` catalogue of a Market's default locale must hold. */
export const MAIL_KEYS = [
  'identity.mail.confirm-email.customer.subject',
  'identity.mail.confirm-email.customer.heading',
  'identity.mail.confirm-email.customer.body',
  'identity.mail.confirm-email.customer.action',
  'identity.mail.existing-account.customer.subject',
  'identity.mail.existing-account.customer.heading',
  'identity.mail.existing-account.customer.body',
  'identity.mail.existing-account.customer.action',
  'identity.mail.confirm-email.seller.subject',
  'identity.mail.confirm-email.seller.heading',
  'identity.mail.confirm-email.seller.body',
  'identity.mail.confirm-email.seller.action',
  'identity.mail.existing-account.seller.subject',
  'identity.mail.existing-account.seller.heading',
  'identity.mail.existing-account.seller.body',
  'identity.mail.existing-account.seller.action',
  'identity.mail.welcome.seller.subject',
  'identity.mail.welcome.seller.heading',
  'identity.mail.welcome.seller.body',
  'identity.mail.welcome.seller.body.no-approval',
  'identity.mail.welcome.seller.action',
  'identity.mail.reset-password.customer.subject',
  'identity.mail.reset-password.customer.heading',
  'identity.mail.reset-password.customer.body',
  'identity.mail.reset-password.customer.action',
  'identity.mail.reset-password.seller.subject',
  'identity.mail.reset-password.seller.heading',
  'identity.mail.reset-password.seller.body',
  'identity.mail.reset-password.seller.action',
  'identity.mail.password-changed.customer.subject',
  'identity.mail.password-changed.customer.heading',
  'identity.mail.password-changed.customer.body',
  'identity.mail.password-changed.seller.subject',
  'identity.mail.password-changed.seller.heading',
  'identity.mail.password-changed.seller.body',
  'identity.mail.reviewer-notice.admin.subject',
  'identity.mail.reviewer-notice.admin.heading',
  'identity.mail.reviewer-notice.admin.body',
  'identity.mail.reviewer-notice.admin.action',
  'identity.mail.reset-password.admin.subject',
  'identity.mail.reset-password.admin.heading',
  'identity.mail.reset-password.admin.body',
  'identity.mail.reset-password.admin.action',
  'identity.mail.password-changed.admin.subject',
  'identity.mail.password-changed.admin.heading',
  'identity.mail.password-changed.admin.body',
  'identity.mail.enrol-second-factor.admin.subject',
  'identity.mail.enrol-second-factor.admin.heading',
  'identity.mail.enrol-second-factor.admin.body',
  'identity.mail.enrol-second-factor.admin.action',
  'identity.mail.invitation.admin.subject',
  'identity.mail.invitation.admin.heading',
  'identity.mail.invitation.admin.body',
  'identity.mail.invitation.admin.action',
  'identity.mail.second-factor-changed.admin.subject',
  'identity.mail.second-factor-changed.admin.heading',
  'identity.mail.second-factor-changed.admin.body.replaced',
  'identity.mail.second-factor-changed.admin.body.reset',
  'identity.mail.second-factor-changed.admin.body.locked',
  'identity.mail.invitation.seller.subject',
  'identity.mail.invitation.seller.heading',
  'identity.mail.invitation.seller.body',
  'identity.mail.invitation.seller.action',
  'identity.mail.seller-approved.seller.subject',
  'identity.mail.seller-approved.seller.heading',
  'identity.mail.seller-approved.seller.body',
  'identity.mail.seller-approved.seller.action',
  'identity.mail.seller-rejected.seller.subject',
  'identity.mail.seller-rejected.seller.heading',
  'identity.mail.seller-rejected.seller.body',
  'identity.mail.seller-rejected.seller.action',
  'identity.mail.seller-suspended.seller.subject',
  'identity.mail.seller-suspended.seller.heading',
  'identity.mail.seller-suspended.seller.body',
  'identity.mail.seller-reinstated.seller.subject',
  'identity.mail.seller-reinstated.seller.heading',
  'identity.mail.seller-reinstated.seller.body',
  'identity.mail.seller-reinstated.seller.action',
  'identity.mail.common.account-line.customer',
  'identity.mail.common.account-line.seller',
  'identity.mail.common.account-line.admin',
  'identity.mail.common.ignore',
  'identity.mail.common.not-you',
  'identity.mail.common.footer',
] as const;
export type MailKey = (typeof MAIL_KEYS)[number];
export type MailCatalogue = Readonly<Record<MailKey, string>>;

/** A hosted Market whose default locale lacks a mail text: refused at boot. */
export class MissingMailCatalogueError extends Error {
  override readonly name = 'MissingMailCatalogueError';
  constructor(marketId: string, locale: string, missing: readonly string[]) {
    super(
      `identity's ${locale} catalogue, the default locale of Market ${marketId}, lacks ` +
        `${missing.join(', ')}`,
    );
  }
}

/**
 * A hosted Market's catalogue that puts the reason of a decision in a mail subject: refused at
 * boot (`ux.md` 3.4: subjects carry no personal data and no reason text; Hassan L2 on PR #204),
 * so a bad locale file never reaches a handler that would retry it.
 */
export class ReasonInSubjectError extends Error {
  override readonly name = 'ReasonInSubjectError';
  constructor(marketId: string, locale: string, keys: readonly string[]) {
    super(
      `identity's ${locale} catalogue, the default locale of Market ${marketId}, puts {reason} ` +
        `in ${keys.join(', ')}: a subject never holds the reason`,
    );
  }
}

const PLACEHOLDER = /\{([a-z]+)\}/g;

/** The result mails of the access decisions (`ux.md` E4 to E7; slice 9). */
const DECISION_MAILS: ReadonlySet<string> = new Set([
  'seller-approved',
  'seller-rejected',
  'seller-suspended',
  'seller-reinstated',
]);

/**
 * {@link IdentityMailComposer} from `identity`'s translation catalogues (identity design 9,
 * INTL-11; `config/locales/<locale>/identity.json`): the Market's default locale, named placeholders and no ICU. Plain text only: no markup can be produced, and
 * the only values filled in are the URL, which code built, the duration and the time, which
 * `Intl` formats, and (slice 9) the reason of a rejection or a suspension, which the domain
 * checked and which is never put in a subject (HF13). A placeholder without a value throws, so a broken locale file
 * never sends a mail with `{url}` in it.
 */
export class CatalogueMailComposer implements IdentityMailComposer {
  readonly #byMarket = new Map<string, MailCatalogue>();

  /** Checks at boot that every hosted Market's default locale has every mail key. */
  constructor(
    private readonly markets: MarketRegistry,
    catalogues: LocaleCatalogues,
  ) {
    for (const marketId of markets.hostedMarketIds()) {
      const locale = markets.get(marketId).defaultLocale;
      const messages = catalogues.messages('identity', locale);
      const missing = MAIL_KEYS.filter((key) => messages?.[key] === undefined);
      if (messages === null || missing.length > 0) {
        throw new MissingMailCatalogueError(marketId, locale, missing);
      }
      const reasonInSubject = MAIL_KEYS.filter(
        (key) => key.endsWith('.subject') && messages[key]!.includes('{reason}'),
      );
      if (reasonInSubject.length > 0) {
        throw new ReasonInSubjectError(marketId, locale, reasonInSubject);
      }
      this.#byMarket.set(marketId, messages);
    }
  }

  compose(market: MarketContext, mail: IdentityMail): ComposedMail {
    const locale = this.markets.get(market.marketId).defaultLocale;
    const catalogue = this.catalogueOf(market.marketId);
    const prefix = `identity.mail.${mail.template}.${mail.population}`;
    const key = (suffix: string): MailKey => {
      const name = `${prefix}.${suffix}`;
      if (!(MAIL_KEYS as readonly string[]).includes(name)) {
        throw new Error(
          `identity has no mail ${mail.template} for the ${mail.population} population`,
        );
      }
      return name as MailKey;
    };
    const values: Record<string, string> = {};
    if (
      mail.template === 'confirm-email' ||
      mail.template === 'reset-password' ||
      mail.template === 'enrol-second-factor' ||
      mail.template === 'invitation'
    ) {
      values['duration'] = formatDuration(locale, mail.lifetimeMinutes);
    }
    const notice =
      mail.template === 'password-changed' || mail.template === 'second-factor-changed';
    // E5 and E6 quote the admin's reason (`ux.md` 3.4): text the domain checked (no control or
    // bidi character), filled into a plain-text body only, never the subject.
    if (mail.template === 'seller-rejected' || mail.template === 'seller-suspended') {
      values['reason'] = mail.reason;
    }
    if (notice) {
      // A notice says when (`ux.md` 3.4): in the Market's zone, the fallback of ADR-0005, since
      // an account has no zone of its own; the zone's name is written with the time.
      const timezone = this.markets.get(market.marketId).timezone;
      values['time'] = formatInstant(locale, timezone, mail.changedAt);
    } else if (mail.template !== 'seller-suspended') {
      values['url'] = mail.url;
    }
    const fill = (template: string): string =>
      template.replace(PLACEHOLDER, (_match, name: string) => {
        const value = values[name];
        if (value === undefined) throw new Error(`mail placeholder {${name}} has no value`);
        return value;
      });
    const line = (name: MailKey): string => fill(catalogue[name]);

    const accountLine = `identity.mail.common.account-line.${mail.population}`;
    if (!(MAIL_KEYS as readonly string[]).includes(accountLine)) {
      throw new Error(`identity has no account line for the ${mail.population} population`);
    }
    // E2 has two bodies, by whether the seller waits for approval (`ux.md` 3.4); the
    // second-factor notice one per change (slice 7b).
    const body =
      mail.template === 'welcome' && !mail.approvalRequired
        ? 'body.no-approval'
        : mail.template === 'second-factor-changed'
          ? `body.${mail.change}`
          : 'body';
    // E13 and the factor notice have no button: "if this wasn't you" in place of "ignore this".
    // E6 (suspended) has none either: the seller cannot sign in while suspended.
    const action =
      notice || mail.template === 'seller-suspended'
        ? []
        : [`${line(key('action'))}: ${(mail as { url: string }).url}`];
    // E3 and the decision mails E4 to E7 answer no request of the reader, so "ignore this" does
    // not fit them (identity design 8.7; `ux.md` 3.4).
    const closing: MailKey[] = notice
      ? ['identity.mail.common.not-you']
      : mail.template === 'reviewer-notice' || DECISION_MAILS.has(mail.template)
        ? []
        : ['identity.mail.common.ignore'];
    const text = [
      line(key('heading')),
      line(key(body)),
      ...action,
      line(accountLine as MailKey),
      ...closing.map(line),
      line('identity.mail.common.footer'),
    ].join('\n\n');
    // Subjects carry no personal data and no reason text (`ux.md` 3.4): the constructor refused
    // a catalogue that puts the reason in a subject (ReasonInSubjectError).
    return { subject: line(key('subject')), text: `${text}\n` };
  }

  private catalogueOf(marketId: MarketContext['marketId']): MailCatalogue {
    const catalogue = this.#byMarket.get(marketId);
    if (catalogue === undefined) throw new Error(`Market ${marketId} is not hosted here`);
    return catalogue;
  }
}

/**
 * An instant as a date and time in the locale and zone, with the zone's name ("8 October 2026 at
 * 10:00:00 am AEST"): a notice's "when" (`ux.md` 3.4; ADR-0005 decision 3).
 */
export function formatInstant(locale: string, timeZone: string, instant: Temporal.Instant): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'long',
    timeZone,
  }).format(new Date(instant.epochMilliseconds));
}

/**
 * A lifetime as a duration in the locale ("24 hours", "24時間"): whole hours when it divides,
 * otherwise minutes (identity design 9; no zone is needed, ADR-0005 decision 3).
 */
export function formatDuration(locale: string, minutes: number): string {
  const [value, unit] = minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}
