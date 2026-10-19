// Storefront feature switches. Each one stays off until john decides; change it here, nowhere else.

/**
 * The seller page's three performance rings (Satisfaction, On time, As described). Off: whether
 * real percentages show before orders exist is not decided (handoffs/seller-page.md).
 */
export const SELLER_RATINGS_SHOWN = false;

/**
 * The order page's "Tax invoice (PDF)" button. Off: it shows only when tax invoices are switched on
 * (tax stage 4 ships switched off), and that is not decided for buyers (handoffs/account.md).
 */
export const TAX_INVOICE_SHOWN = false;

/**
 * Log in or create an account with Google or Apple. Off until the social sign-in server side ships
 * (john 19 Oct asked for it; its own build thread). The buttons run on a sample until then.
 */
export const SOCIAL_SIGN_IN_SHOWN = false;
