import 'server-only';
import { redirect } from 'next/navigation';
import type { FormDescriptors, MyFile } from '../setup/types.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type SetupPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly file: MyFile;
      readonly descriptors: FormDescriptors;
    }
  | { readonly kind: 'unavailable'; readonly session: SellerSession | null };

/**
 * Everything a setup page needs: the session, the seller's own draft and the Market's form
 * descriptors. An approved seller has no setup pages (they go to Home).
 */
export async function loadSetupPage(): Promise<SetupPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable', session: null };
  const { session } = gate;
  if (session.sellerAccessState === 'approved') redirect('/');
  const [file, descriptors] = await Promise.all([
    serverGet<MyFile>('sellers/my-file'),
    serverGet<FormDescriptors>('sellers/my-file/form-descriptors'),
  ]);
  if (file.kind === 'signed-out' || descriptors.kind === 'signed-out') redirect('/session-ended');
  if (file.kind !== 'ok' || descriptors.kind !== 'ok') return { kind: 'unavailable', session };
  return { kind: 'ok', session, file: file.body, descriptors: descriptors.body };
}
