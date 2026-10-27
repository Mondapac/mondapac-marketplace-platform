'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { sealArt } from '../certification/certification-seal.tsx';
import { deliverToLabel } from '../delivery/deliver-to.ts';
import { Icon } from '../icons/icon.tsx';
import type { IconName } from '../icons/icon-paths.tsx';
import { Logo } from './logo.tsx';
import { useStore } from './store-context.tsx';
import { from } from './breakpoints.ts';

const COLUMNS = [
  {
    title: 'shop',
    links: [
      ['browse', '/browse'],
      ['offers', '/offers'],
      ['express', '/express'],
      ['sellers', '/sellers'],
      ['certified', '/certified'],
      ['saved', '/account/lists'],
    ],
  },
  {
    title: 'help',
    links: [
      ['delivery', '/help/delivery'],
      ['track', '/account/orders'],
      ['returns', '/help/returns'],
      ['contact', '/help/contact'],
      ['faq', '/help'],
    ],
  },
  {
    title: 'sell',
    links: [
      ['become', '/sell'],
      ['sign-in', '/sell/sign-in'],
      ['guidelines', '/sell/guidelines'],
      ['labels', '/help/certificates'],
    ],
  },
  {
    title: 'company',
    links: [
      ['about', '/about'],
      ['terms', '/terms'],
      ['privacy', '/privacy'],
      ['cookies', '/cookies'],
    ],
  },
] as const;

/** Desktop shows every column open; phones fold them. */
function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(from('desktop'));
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return desktop;
}

function Column({
  title,
  desktop,
  children,
}: {
  title: string;
  desktop: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="fcol"
      open={desktop || open}
      onToggle={(event) => {
        if (!desktop) setOpen(event.currentTarget.open);
      }}
    >
      <summary tabIndex={desktop ? -1 : undefined}>
        {title}
        <Icon name="chevd" />
      </summary>
      <ul>{children}</ul>
    </details>
  );
}

export function Footer({ area }: { readonly area: string }) {
  const t = useTranslations('footer');
  const name = useTranslations('store')('name');
  const desktop = useDesktop();
  const { deliverTo } = useStore();
  const shown = deliverTo ? deliverToLabel(deliverTo) : area;
  const trust: [IconName | 'seal', string][] = [
    ['seal', 'certificates'],
    ['truck', 'delivery'],
    ['receipt', 'gst'],
    ['lock', 'secure'],
  ];
  return (
    <footer className="foot">
      <div className="fband">
        <ul className="ftrust">
          {trust.map(([icon, key]) => (
            <li key={key}>
              {icon === 'seal' ? (
                <span className="fi sealbox">{sealArt('halal')}</span>
              ) : (
                <span className="fi">
                  <Icon name={icon} />
                </span>
              )}
              <b>{t(`trust.${key}`)}</b>
              <span className="d">{t(`trust.${key}-body`)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="fbody">
        <div className="fbrand">
          <Logo name={name} />
          <p className="fdesc">{t('about')}</p>
          <div className="fc">
            <a href={`mailto:${t('email')}`}>
              <Icon name="mail" />
              {t('email')}
            </a>
            <Link href="/delivery-area">
              <Icon name="pin" />
              {t('delivering', { area: shown })}
            </Link>
          </div>
          <div className="fsoc" role="group" aria-label={t('social')}>
            <SocialLinks />
          </div>
        </div>
        {COLUMNS.map((column) => (
          <Column key={column.title} title={t(column.title)} desktop={desktop}>
            {column.links.map(([key, href]) => (
              <li key={key}>
                <Link href={href}>{t(`${column.title}-links.${key}`)}</Link>
              </li>
            ))}
          </Column>
        ))}
      </div>
      <div className="fbase">
        <div className="fl">
          <span>{t('copyright')}</span>
          <Link href="/terms">{t('terms')}</Link>
          <Link href="/privacy">{t('privacy')}</Link>
          <Link href="/cookies">{t('cookies')}</Link>
        </div>
        <PaymentMarks label={t('payments')} />
        <button
          className="btt"
          type="button"
          aria-label={t('back-to-top')}
          onClick={() => window.scrollTo({ top: 0 })}
        >
          <Icon name="up" />
        </button>
      </div>
    </footer>
  );
}

function SocialLinks() {
  return (
    <>
      <a href="https://www.instagram.com/" aria-label="Instagram" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect
            x="3.5"
            y="3.5"
            width="17"
            height="17"
            rx="5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
        </svg>
      </a>
      <a href="https://www.facebook.com/" aria-label="Facebook" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M13.5 21v-8h2.7l.4-3.2h-3.1V7.8c0-.9.3-1.5 1.6-1.5h1.7V3.4c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1v2.4H7.7V13h2.7v8z"
          />
        </svg>
      </a>
      <a href="https://www.tiktok.com/" aria-label="TikTok" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16.6 3c.3 2.3 1.6 3.7 3.9 3.9v3c-1.4.1-2.6-.3-3.9-1.1v5.4c0 6.9-7.5 8.9-10.2 4-1.7-3.1-.1-8 5.5-8.2v3.2c-.4.1-.9.2-1.3.4-1.2.5-1.8 1.7-1.5 2.9.6 2.4 4.7 2.7 4.7-1.2V3z"
          />
        </svg>
      </a>
      <a href="https://www.youtube.com/" aria-label="YouTube" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M21.6 7.2a2.5 2.5 0 00-1.7-1.8C18.4 5 12 5 12 5s-6.4 0-7.9.4A2.5 2.5 0 002.4 7.2C2 8.7 2 12 2 12s0 3.3.4 4.8a2.5 2.5 0 001.7 1.8C5.6 19 12 19 12 19s6.4 0 7.9-.4a2.5 2.5 0 001.7-1.8C22 15.3 22 12 22 12s0-3.3-.4-4.8zM10 15V9l5.2 3z"
          />
        </svg>
      </a>
    </>
  );
}

// Payment marks drawn as text in each brand's colour; replaced by the official artwork once
// the payment providers are contracted.
function PaymentMarks({ label }: { readonly label: string }) {
  return (
    <ul className="pay" aria-label={label}>
      <li className="pm">
        <svg viewBox="0 0 54 32" role="img" aria-label="Visa">
          <text
            x="27"
            y="22"
            textAnchor="middle"
            fontSize="17"
            fontWeight="900"
            fontStyle="italic"
            fill="#1A1F71"
            fontFamily="Arial, Helvetica, sans-serif"
            letterSpacing="-.5"
          >
            VISA
          </text>
        </svg>
      </li>
      <li className="pm">
        <svg viewBox="0 0 54 32" role="img" aria-label="Mastercard">
          <circle cx="21" cy="14" r="9" fill="#EB001B" />
          <circle cx="33" cy="14" r="9" fill="#F79E1B" />
          <path d="M27 6.6a9 9 0 010 14.8 9 9 0 010-14.8z" fill="#FF5F00" />
          <text
            x="27"
            y="29.5"
            textAnchor="middle"
            fontSize="5"
            fontWeight="700"
            fill="#333"
            fontFamily="Arial, Helvetica, sans-serif"
          >
            mastercard
          </text>
        </svg>
      </li>
      <li className="pm">
        <svg viewBox="0 0 54 32" role="img" aria-label="Stripe">
          <text
            x="27"
            y="21"
            textAnchor="middle"
            fontSize="15"
            fontWeight="800"
            fill="#635BFF"
            fontFamily="Arial, Helvetica, sans-serif"
            letterSpacing="-.4"
          >
            stripe
          </text>
        </svg>
      </li>
    </ul>
  );
}
