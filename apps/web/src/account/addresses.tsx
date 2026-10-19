'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { inServiceArea } from '../checkout/checkout-page.tsx';
import { Icon } from '../icons/icon.tsx';
import type { SavedAddress, ServiceArea } from '../storefront/types.ts';
import { AccountEmpty, AccountFrame } from './account-area.tsx';
import { useAccount } from './account-state.tsx';
import { AcField } from './fields.tsx';

interface Draft {
  readonly label: string;
  readonly name: string;
  readonly street: string;
  readonly suburb: string;
  readonly postcode: string;
  readonly phone: string;
}

/** Splits a saved one-line address ("12 Example Street, Kedron QLD 4031") into form fields. */
function draftOf(address: SavedAddress | null): Draft {
  if (!address) return { label: '', name: '', street: '', suburb: '', postcode: '', phone: '' };
  const cut = address.line.lastIndexOf(', ');
  const street = cut < 0 ? address.line : address.line.slice(0, cut);
  const words = cut < 0 ? [] : address.line.slice(cut + 2).split(' ');
  const postcode = /^\d+$/.test(words.at(-1) ?? '') ? (words.pop() ?? '') : '';
  words.pop(); // the state
  return {
    label: address.label,
    name: address.name,
    street,
    suburb: words.join(' '),
    postcode,
    phone: address.phone,
  };
}

/** The postcode at the end of a saved line, for the outside-area mark. */
function postcodeOf(line: string): string {
  return /(\d{4})$/.exec(line)?.[1] ?? '';
}

/**
 * Addresses: the address book with Add, Edit, Make default and Delete (asked first). An address
 * outside the delivery area can be saved; it is marked and a notice says so (handoffs/account.md).
 */
export function AccountAddresses() {
  const t = useTranslations('account');
  const { addresses, source, makeDefault, deleteAddress } = useAccount();
  const area = source.serviceArea;
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (editing === null && back.current) addButton.current?.focus({ preventScroll: true });
    back.current = editing !== null;
  }, [editing]);

  if (editing !== null)
    return (
      <AccountFrame title={t('titles.addresses')}>
        <AddressForm
          area={area}
          address={addresses.find((a) => a.id === editing) ?? null}
          onDone={() => setEditing(null)}
        />
      </AccountFrame>
    );

  return (
    <AccountFrame title={t('titles.addresses')}>
      <div className="ac-row">
        <p className="ac-note ac-grow">
          <Icon name="info" />
          <span>{t('addresses.area-note', { area: area.name })}</span>
        </p>
        <button ref={addButton} className="btn" type="button" onClick={() => setEditing('new')}>
          {t('addresses.add')}
        </button>
      </div>
      {addresses.length === 0 ? (
        <AccountEmpty icon="pin" title={t('addresses.none')}>
          <p>{t('addresses.none-body')}</p>
        </AccountEmpty>
      ) : (
        <div className="ac-addr">
          {addresses.map((a) => (
            <article
              className={a.isDefault ? 'ac-ad def' : 'ac-ad'}
              key={a.id}
              aria-label={a.label}
            >
              <div className="ac-row">
                <b>{a.label}</b>
                {a.isDefault ? <span className="ac-badge ok">{t('addresses.default')}</span> : null}
              </div>
              <span>{a.name}</span>
              <span>{a.line}</span>
              <span>{a.phone}</span>
              {inServiceArea(area, postcodeOf(a.line)) ? null : (
                <span className="ac-badge wait ac-start">{t('addresses.outside')}</span>
              )}
              {deleting === a.id ? (
                <div
                  className="ac-confirm"
                  role="alertdialog"
                  aria-label={t('addresses.delete-title')}
                >
                  <b>{t('addresses.delete-title')}</b>
                  <div className="ac-acts">
                    <button
                      className="btn"
                      type="button"
                      autoFocus
                      onClick={() => {
                        deleteAddress(a.id);
                        setDeleting(null);
                      }}
                    >
                      {t('addresses.delete')}
                    </button>
                    <button className="btn ghost" type="button" onClick={() => setDeleting(null)}>
                      {t('addresses.keep')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ac-acts">
                  <button
                    className="lnk"
                    type="button"
                    aria-label={t('addresses.edit-label', { label: a.label })}
                    onClick={() => setEditing(a.id)}
                  >
                    {t('addresses.edit')}
                  </button>
                  {a.isDefault ? null : (
                    <button
                      className="lnk"
                      type="button"
                      aria-label={t('addresses.make-default-label', { label: a.label })}
                      onClick={() => makeDefault(a.id)}
                    >
                      {t('addresses.make-default')}
                    </button>
                  )}
                  <button
                    className="lnk"
                    type="button"
                    aria-label={t('addresses.delete-label', { label: a.label })}
                    onClick={() => setDeleting(a.id)}
                  >
                    {t('addresses.delete')}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </AccountFrame>
  );
}

function AddressForm({
  area,
  address,
  onDone,
}: {
  readonly area: ServiceArea;
  readonly address: SavedAddress | null;
  readonly onDone: () => void;
}) {
  const t = useTranslations('account.addresses');
  const { saveAddress } = useAccount();
  const [draft, setDraft] = useState<Draft>(() => draftOf(address));
  const [tried, setTried] = useState(false);
  const set = (key: keyof Draft) => (text: string) => setDraft({ ...draft, [key]: text });
  const missing = (key: keyof Draft) =>
    tried && draft[key].trim() === '' ? t('required') : undefined;
  const postcode = draft.postcode.trim();
  const postcodeError = tried && !/^\d{4}$/.test(postcode) ? t('postcode-bad') : undefined;
  const outside = /^\d{4}$/.test(postcode) && !inServiceArea(area, postcode);

  return (
    <section className="ac-card" aria-labelledby="address-form">
      <h2 id="address-form">{address ? t('edit-title') : t('add')}</h2>
      <form
        className="ac-f"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          const required: (keyof Draft)[] = ['name', 'street', 'suburb', 'phone'];
          if (required.some((k) => draft[k].trim() === '') || !/^\d{4}$/.test(postcode)) return;
          saveAddress({
            id: address?.id ?? `address-${Date.now()}`,
            label: draft.label.trim() || t('fallback-label'),
            name: draft.name.trim(),
            line: `${draft.street.trim()}, ${draft.suburb.trim()} ${area.region} ${postcode}`,
            phone: draft.phone.trim(),
            isDefault: address?.isDefault ?? false,
          });
          onDone();
        }}
      >
        <div className="ac-f2">
          <AcField
            label={t('label')}
            placeholder={t('label-hint')}
            value={draft.label}
            onText={set('label')}
            autoFocus
          />
          <AcField
            label={t('full-name')}
            autoComplete="name"
            value={draft.name}
            onText={set('name')}
            error={missing('name')}
          />
        </div>
        <AcField
          label={t('street')}
          autoComplete="address-line1"
          value={draft.street}
          onText={set('street')}
          error={missing('street')}
        />
        <div className="ac-f2">
          <AcField
            label={t('suburb')}
            autoComplete="address-level2"
            value={draft.suburb}
            onText={set('suburb')}
            error={missing('suburb')}
          />
          <AcField label={t('state')} value={area.region} readOnly />
          <AcField
            label={t('postcode')}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={4}
            value={draft.postcode}
            onText={set('postcode')}
            error={postcodeError}
          />
        </div>
        {outside ? (
          <p className="ac-note ac-warn" role="status">
            <Icon name="info" />
            <span>{t('postcode-outside', { postcode, area: area.name })}</span>
          </p>
        ) : null}
        <AcField
          label={t('mobile')}
          autoComplete="tel"
          inputMode="tel"
          value={draft.phone}
          onText={set('phone')}
          hint={t('mobile-hint')}
          error={missing('phone')}
        />
        <div className="ac-acts">
          <button className="btn" type="submit">
            {t('save')}
          </button>
          <button className="btn ghost" type="button" onClick={onDone}>
            {t('cancel')}
          </button>
        </div>
      </form>
    </section>
  );
}
