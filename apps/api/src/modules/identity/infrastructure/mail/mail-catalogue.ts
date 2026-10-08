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
  'identity.mail.common.account-line.customer',
  'identity.mail.common.account-line.seller',
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

const PLACEHOLDER = /\{([a-z]+)\}/g;

/**
 * {@link IdentityMailComposer} from `identity`'s translation catalogues (identity design 9,
 * INTL-11; `config/locales/<locale>/identity.json`): the Market's default locale, named placeholders and no ICU. Plain text only: no markup can be produced, and
 * the only values filled in are the URL, which code built, and the duration, which `Intl`
 * formats from a number (HF13). A placeholder without a value throws, so a broken locale file
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
    if (mail.template === 'confirm-email' || mail.template === 'reset-password') {
      values['duration'] = formatDuration(locale, mail.lifetimeMinutes);
    }
    if (mail.template === 'password-changed') {
      // A notice says when (`ux.md` 3.4): in the Market's zone, the fallback of ADR-0005, since
      // an account has no zone of its own; the zone's name is written with the time.
      const timezone = this.markets.get(market.marketId).timezone;
      values['time'] = formatInstant(locale, timezone, mail.changedAt);
    } else {
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
    // E2 has two bodies, by whether the seller waits for approval (`ux.md` 3.4).
    const body =
      mail.template === 'welcome' && !mail.approvalRequired ? 'body.no-approval' : 'body';
    // E13 is a notice without a button: "if this wasn't you" in place of "ignore this" (3.4).
    const action =
      mail.template === 'password-changed' ? [] : [`${line(key('action'))}: ${mail.url}`];
    const closing: MailKey =
      mail.template === 'password-changed'
        ? 'identity.mail.common.not-you'
        : 'identity.mail.common.ignore';
    const text = [
      line(key('heading')),
      line(key(body)),
      ...action,
      line(accountLine as MailKey),
      line(closing),
      line('identity.mail.common.footer'),
    ].join('\n\n');
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
