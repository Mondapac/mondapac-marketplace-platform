import type { MarketContext, Population } from '@mondapac/shared-kernel';

/**
 * The mails of `identity` in slice 3 (identity design 9; `ux.md` 5, E1 and E12). What varies is
 * data; the words come from the module's locale files, in the Market's default locale.
 */
export type IdentityMail =
  | {
      readonly template: 'confirm-email';
      readonly population: Population;
      /** The confirmation page, with the token in the fragment. */
      readonly url: string;
      readonly lifetimeMinutes: number;
    }
  | {
      readonly template: 'existing-account';
      readonly population: Population;
      /** The sign-in page. */
      readonly url: string;
    };

/** A rendered mail: plain text only (identity design 9; HF13). */
export interface ComposedMail {
  readonly subject: string;
  readonly text: string;
}

/**
 * Renders a mail of `identity` (identity design 9, translation keys `identity.mail.<template>`):
 * named placeholders, no ICU, the lifetime as a duration so no zone is needed (ADR-0005
 * decision 3). Throws when the Market's locale has no catalogue, which the module checks at boot.
 */
export interface IdentityMailComposer {
  compose(market: MarketContext, mail: IdentityMail): ComposedMail;
}

/** Nest token of the {@link IdentityMailComposer}. */
export const IDENTITY_MAIL_COMPOSER = Symbol('IDENTITY_MAIL_COMPOSER');
