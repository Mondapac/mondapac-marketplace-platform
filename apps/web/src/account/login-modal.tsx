'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { CheckoutCustomer, SignInProvider } from '../storefront/types.ts';
import { AuthForms } from './auth-forms.tsx';
import { useDialog } from './use-dialog.ts';

/**
 * The log-in dialog (header Log in, the rail's My Account, the Account tab signed out): Log in,
 * Create account and Forgot password. Signing in opens the account overview. Sample: it signs in
 * to `customer` until customer sessions are wired.
 */
export function LoginModal({
  customer,
  providers,
}: {
  readonly customer: CheckoutCustomer;
  readonly providers: readonly SignInProvider[];
}) {
  const t = useTranslations('account.auth');
  const router = useRouter();
  const { loginOpen: open, setLoginOpen, setCustomer } = useStore();
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setLoginOpen(false);
  useEffect(() => setMounted(true), []);
  useDialog(open, close, panel, (root) => root.querySelector('input'));

  if (!mounted) return null;
  return createPortal(
    <div className={open ? 'amw open' : 'amw'}>
      <div className="amscrim" onClick={close} />
      <div className="ambox">
        <div
          className="amdlg"
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-title"
          inert={!open}
        >
          {open ? (
            <AuthForms
              providers={providers}
              heading={(title) => (
                <div className="amh">
                  <h2 id="login-title">{title}</h2>
                  <button className="iconbtn" type="button" aria-label={t('close')} onClick={close}>
                    <Icon name="close" />
                  </button>
                </div>
              )}
              onSignedIn={() => {
                setCustomer(customer);
                close();
                router.push('/account');
              }}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
