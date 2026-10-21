'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Money } from '../storefront/types.ts';

// The Card tile's fields: Stripe's Payment Element, loaded from js.stripe.com (Stripe requires
// that origin) with a test-mode publishable key. The card number, expiry and security code are
// typed into Stripe's own frames; this page only gets a confirmation token (`ctoken_...`), which
// Pay sends to the server. The amount follows the total; capture is manual (ordering captures
// once the seller accepts). Only the types used here are declared, so no Stripe package is added.

const STRIPE_JS = 'https://js.stripe.com/v3/';

interface StripeError {
  readonly type?: string;
  readonly message?: string;
}
interface StripeElement {
  mount(target: HTMLElement): void;
  destroy(): void;
  on(event: 'ready' | 'loaderror', handler: () => void): void;
}
interface StripeElements {
  create(type: 'payment', options: Record<string, unknown>): StripeElement;
  update(options: Record<string, unknown>): void;
  submit(): Promise<{ readonly error?: StripeError }>;
}
interface StripeJs {
  elements(options: Record<string, unknown>): StripeElements;
  createConfirmationToken(options: {
    readonly elements: StripeElements;
    readonly params: Record<string, unknown>;
  }): Promise<{
    readonly confirmationToken?: { readonly id: string };
    readonly error?: StripeError;
  }>;
}
type StripeFactory = (publishableKey: string) => StripeJs;

declare global {
  interface Window {
    Stripe?: StripeFactory;
  }
}

let loading: Promise<StripeFactory> | null = null;

/** Loads Stripe.js once per page; a failed load can be tried again. */
function loadStripe(): Promise<StripeFactory> {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  loading ??= new Promise<StripeFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = STRIPE_JS;
    script.async = true;
    script.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error('no Stripe')));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Stripe.js did not load'));
    };
    document.head.append(script);
  });
  return loading;
}

export type CardFieldsState = 'loading' | 'ready' | 'failed';

/** The result of turning the card fields into a token. */
export type CardToken =
  | { readonly kind: 'token'; readonly id: string }
  /** Stripe shows what to fix inside its fields. */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed' };

/** The page's colours for Stripe's frames, read from the storefront tokens. */
function appearance(): Record<string, unknown> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim() || undefined;
  return {
    theme: 'stripe',
    variables: {
      colorPrimary: token('--sf-teal'),
      colorText: token('--sf-ink'),
      colorDanger: token('--sf-error'),
      borderRadius: '10px',
    },
  };
}

/**
 * Mounts the Payment Element (cards only: Apple Pay and Google Pay are on Stripe's page) into the
 * returned ref while `publishableKey` is set, and turns it into a confirmation token on Pay.
 */
export function useStripeCard(publishableKey: string | null, total: Money) {
  const target = useRef<HTMLDivElement>(null);
  const stripe = useRef<{ js: StripeJs; elements: StripeElements } | null>(null);
  const [state, setState] = useState<CardFieldsState>('loading');
  const [attempt, setAttempt] = useState(0);
  // The first amount mounts the fields; later totals update them (below).
  const first = useRef(total);

  useEffect(() => {
    if (publishableKey === null) return;
    let element: StripeElement | null = null;
    let live = true;
    setState('loading');
    loadStripe().then(
      (factory) => {
        const node = target.current;
        if (!live || !node) return;
        const js = factory(publishableKey);
        const elements = js.elements({
          mode: 'payment',
          amount: first.current.amount,
          currency: first.current.currency.toLowerCase(),
          captureMethod: 'manual',
          paymentMethodTypes: ['card'],
          appearance: appearance(),
        });
        element = elements.create('payment', {
          layout: 'tabs',
          wallets: { applePay: 'never', googlePay: 'never' },
        });
        element.on('ready', () => live && setState('ready'));
        element.on('loaderror', () => live && setState('failed'));
        element.mount(node);
        stripe.current = { js, elements };
      },
      () => live && setState('failed'),
    );
    return () => {
      live = false;
      element?.destroy();
      stripe.current = null;
    };
  }, [publishableKey, attempt]);

  useEffect(() => {
    stripe.current?.elements.update({
      amount: total.amount,
      currency: total.currency.toLowerCase(),
    });
  }, [total.amount, total.currency]);

  const tokenize = useCallback(async (name: string): Promise<CardToken> => {
    const current = stripe.current;
    if (!current) return { kind: 'failed' };
    try {
      const submitted = await current.elements.submit();
      if (submitted.error) return { kind: 'invalid' };
      const made = await current.js.createConfirmationToken({
        elements: current.elements,
        params: { payment_method_data: { billing_details: { name } } },
      });
      if (made.confirmationToken) return { kind: 'token', id: made.confirmationToken.id };
      return made.error?.type === 'validation_error' ? { kind: 'invalid' } : { kind: 'failed' };
    } catch {
      return { kind: 'failed' };
    }
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { target, state, tokenize, retry };
}
