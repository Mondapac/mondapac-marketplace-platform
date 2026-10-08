import type { MarketContext, Population, Temporal } from '@mondapac/shared-kernel';

/**
 * The mails of `identity` in slices 3 to 5 (identity design 9; `ux.md` 5, E1, E2, E8, E12, E13). What
 * varies is data; the words come from the module's locale files, in the Market's default locale.
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
      /** E8: the reset link (slice 4). */
      readonly template: 'reset-password';
      readonly population: Population;
      /** The reset page, with the token in the fragment. */
      readonly url: string;
      readonly lifetimeMinutes: number;
    }
  | {
      /**
       * E13: the password was changed or reset (slice 4). A notice without a button (`ux.md`
       * 3.4): what changed, when, and "if this wasn't you".
       */
      readonly template: 'password-changed';
      readonly population: Population;
      /** When the password was changed: written in the Market's time zone and locale. */
      readonly changedAt: Temporal.Instant;
    }
  | {
      readonly template: 'existing-account';
      readonly population: Population;
      /** The sign-in page. */
      readonly url: string;
    }
  | {
      /** E2, to a self-registered seller's owner after the email is confirmed (slice 5). */
      readonly template: 'welcome';
      readonly population: 'seller';
      /** The sign-in page ("View your account"). */
      readonly url: string;
      /** Whether the seller waits for approval: the body differs (`ux.md` 3.4). */
      readonly approvalRequired: boolean;
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
