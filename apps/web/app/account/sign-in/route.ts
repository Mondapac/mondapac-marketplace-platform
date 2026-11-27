import { redirect } from 'next/navigation';

/**
 * The Market's customer sign-in link (identity.links.targets.customer.sign-in), which mails such
 * as "you already have an account" use: signed out, /account shows the log-in form.
 */
export function GET(): never {
  redirect('/account');
}
