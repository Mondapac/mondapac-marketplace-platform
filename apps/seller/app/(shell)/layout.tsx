import type { ReactNode } from 'react';
import { requireSession } from '../../src/server/session.ts';

/**
 * Sends a signed-out visitor to sign-in before anything of the panel is sent. This layout sits
 * outside the segment's `loading.tsx` boundary, so the redirect is a plain HTTP redirect: without
 * it the shell frame and the skeleton streamed first and the sign-in page followed a moment later.
 * The page still reads the session itself (client navigations do not re-render this layout); the
 * read is shared through `cache`, so a first load asks the API once. `unavailable` passes
 * through for the page to show as an error.
 */
export default async function ShellLayout({ children }: { readonly children: ReactNode }) {
  await requireSession();
  return children;
}
