import type { MarketContext } from '@mondapac/shared-kernel';
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
  'identity.mail.common.account-line.customer',
  'identity.mail.common.ignore',
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
    const values: Record<string, string> = { url: mail.url };
    if (mail.template === 'confirm-email') {
      values['duration'] = formatDuration(locale, mail.lifetimeMinutes);
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
    const text = [
      line(key('heading')),
      line(key('body')),
      `${line(key('action'))}: ${mail.url}`,
      line(accountLine as MailKey),
      line('identity.mail.common.ignore'),
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
 * A lifetime as a duration in the locale ("24 hours", "24時間"): whole hours when it divides,
 * otherwise minutes (identity design 9; no zone is needed, ADR-0005 decision 3).
 */
export function formatDuration(locale: string, minutes: number): string {
  const [value, unit] = minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}
