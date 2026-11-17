import { redirect } from 'next/navigation';

/** The menu item opens the alerts tab; /security itself has no page of its own. */
export default function SecurityPage(): never {
  redirect('/security/alerts');
}
