import { ConfirmEmail } from '../../../src/account/confirm-email.tsx';

// The page a customer's confirmation mail links to (identity.links.targets.customer.verify-email
// in config/markets/<ID>.json, the token in the fragment). Out of the index, as every /account
// page (the account layout's metadata).
export default function ConfirmEmailPage() {
  return <ConfirmEmail />;
}
