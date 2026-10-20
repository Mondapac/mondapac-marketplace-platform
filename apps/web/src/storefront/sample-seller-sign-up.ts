import type { SellerSignUpSetup } from './types.ts';

/** The AU Market's values (config/markets/AU.json) until the storefront reads the Market config. */
export const SAMPLE_SELLER_SIGN_UP: SellerSignUpSetup = {
  passwordMinLength: 15,
  passwordMaxLength: 128,
  serviceArea: 'Greater Brisbane',
  businessIdentifier: 'ABN',
  sellerSignInUrl: 'https://seller.au.mondapac.test/sign-in',
};
