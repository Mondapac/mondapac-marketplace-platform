'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { inServiceArea } from '../checkout/checkout-page.tsx';
import { Icon } from '../icons/icon.tsx';
import type { SavedAddress, ServiceArea } from '../storefront/types.ts';
import { AccountEmpty, AccountFrame } from './account-area.tsx';
import { addressLine, recipientName } from './address-line.ts';
import { useAccount, type SaveOutcome } from './account-state.tsx';
import { AcField } from './fields.tsx';

interface Draft {
  readonly firstName: string;
  readonly lastName: string;
  readonly street: string;
  readonly suburb: string;
  readonly postcode: string;
  readonly phone: string;
}

function draftOf(address: SavedAddress | null): Draft {
  return {
    firstName: address?.firstName ?? '',
    lastName: address?.lastName ?? '',
    street: address?.street ?? '',
    suburb: address?.suburb ?? '',
    postcode: address?.postcode ?? '',
    phone: address?.phone ?? '',
  };
}

/** The body field the API names in a refusal, as the form's field. */
const DRAFT_OF_PATH: Readonly<Record<string, keyof Draft>> = {
  recipientFirstName: 'firstName',
  recipientLastName: 'lastName',
  line1: 'street',
  suburb: 'suburb',
  postcode: 'postcode',
  phone: 'phone',
};

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
  // A delete or make-default the API could not do.
  const [failed, setFailed] = useState(false);
  const change = (outcome: Promise<SaveOutcome>, done?: () => void) => {
    setFailed(false);
    void outcome.then((result) => {
      if (result.ok) done?.();
      else setFailed(true);
    });
  };
  // After the delete question closes, focus goes to this control (by id) instead of the page.
  const [focusTo, setFocusTo] = useState<string | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo)?.focus({ preventScroll: true });
    setFocusTo(null);
  }, [focusTo]);
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
        <button
          ref={addButton}
          id="address-add"
          className="btn"
          type="button"
          onClick={() => setEditing('new')}
        >
          {t('addresses.add')}
        </button>
      </div>
      {failed ? (
        <p className="ac-note ac-warn" role="alert">
          <Icon name="info" />
          <span>{t('addresses.failed')}</span>
        </p>
      ) : null}
      {addresses.length === 0 ? (
        <AccountEmpty icon="pin" title={t('addresses.none')}>
          <p>{t('addresses.none-body')}</p>
        </AccountEmpty>
      ) : (
        <div className="ac-addr">
          {addresses.map((a, i) => (
            <article
              className={a.isDefault ? 'ac-ad def' : 'ac-ad'}
              key={a.id}
              aria-label={recipientName(a)}
            >
              <div className="ac-row">
                <b>{recipientName(a)}</b>
                {a.isDefault ? <span className="ac-badge ok">{t('addresses.default')}</span> : null}
              </div>
              <span>{addressLine(a, area.regionCode)}</span>
              <span>{a.phone}</span>
              {inServiceArea(area, a.postcode) ? null : (
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
                      className="btn ghost ac-danger"
                      type="button"
                      onClick={() => {
                        const next = addresses[i + 1] ?? addresses[i - 1];
                        change(deleteAddress(a.id), () => {
                          setDeleting(null);
                          setFocusTo(next ? `address-delete-${next.id}` : 'address-add');
                        });
                      }}
                    >
                      {t('addresses.delete')}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      autoFocus
                      onClick={() => {
                        setDeleting(null);
                        setFocusTo(`address-delete-${a.id}`);
                      }}
                    >
                      {t('addresses.keep')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ac-acts">
                  <button
                    className="lnk"
                    type="button"
                    aria-label={t('addresses.edit-label', { name: recipientName(a) })}
                    onClick={() => setEditing(a.id)}
                  >
                    {t('addresses.edit')}
                  </button>
                  {a.isDefault ? null : (
                    <button
                      className="lnk"
                      type="button"
                      aria-label={t('addresses.make-default-label', { name: recipientName(a) })}
                      onClick={() => change(makeDefault(a.id))}
                    >
                      {t('addresses.make-default')}
                    </button>
                  )}
                  <button
                    id={`address-delete-${a.id}`}
                    className="lnk"
                    type="button"
                    aria-label={t('addresses.delete-label', { name: recipientName(a) })}
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
  const [tries, setTries] = useState(0);
  const tried = tries > 0;
  const form = useRef<HTMLFormElement>(null);
  // A refused save takes the keyboard to the first field to fix.
  useEffect(() => {
    if (tries > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [tries]);
  const [problem, setProblem] = useState<SaveOutcome | null>(null);
  const [pending, setPending] = useState(false);
  const set = (key: keyof Draft) => (text: string) => setDraft({ ...draft, [key]: text });
  const missing = (key: 'firstName' | 'lastName' | 'street' | 'suburb' | 'phone') =>
    tried && draft[key].trim() === '' ? t(`missing.${key}`) : undefined;
  // Fields the API refused (live), by form field.
  const refused = (key: keyof Draft) =>
    problem && !problem.ok && problem.fields.some((f) => DRAFT_OF_PATH[f.path] === key)
      ? t('field-bad')
      : undefined;
  const postcode = draft.postcode.trim();
  const postcodeError =
    tried && !/^\d{4}$/.test(postcode) ? t('postcode-bad') : refused('postcode');
  const outside = /^\d{4}$/.test(postcode) && !inServiceArea(area, postcode);

  return (
    <section className="ac-card" aria-labelledby="address-form">
      <h2 id="address-form">{address ? t('edit-title') : t('add')}</h2>
      <form
        className="ac-f"
        ref={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const required: (keyof Draft)[] = ['firstName', 'lastName', 'street', 'suburb', 'phone'];
          if (required.some((k) => draft[k].trim() === '') || !/^\d{4}$/.test(postcode)) {
            setTries(tries + 1);
            return;
          }
          setPending(true);
          setProblem(null);
          void saveAddress({
            id: address?.id ?? '',
            firstName: draft.firstName.trim(),
            lastName: draft.lastName.trim(),
            street: draft.street.trim(),
            line2: address?.line2 ?? null,
            suburb: draft.suburb.trim(),
            postcode,
            phone: draft.phone.trim(),
            deliveryNotes: address?.deliveryNotes ?? null,
            isDefault: address?.isDefault ?? false,
          }).then((result) => {
            setPending(false);
            if (result.ok) onDone();
            else {
              setProblem(result);
              // The fields the API refused take the keyboard, as a refused local check does.
              setTries((n) => n + 1);
            }
          });
        }}
      >
        <div className="ac-f2">
          <AcField
            label={t('first-name')}
            autoComplete="given-name"
            value={draft.firstName}
            onText={set('firstName')}
            error={missing('firstName') ?? refused('firstName')}
            autoFocus
          />
          <AcField
            label={t('last-name')}
            autoComplete="family-name"
            value={draft.lastName}
            onText={set('lastName')}
            error={missing('lastName') ?? refused('lastName')}
          />
        </div>
        <AcField
          label={t('street')}
          autoComplete="address-line1"
          value={draft.street}
          onText={set('street')}
          error={missing('street') ?? refused('street')}
        />
        <div className="ac-f2">
          <AcField
            label={t('suburb')}
            autoComplete="address-level2"
            value={draft.suburb}
            onText={set('suburb')}
            error={missing('suburb') ?? refused('suburb')}
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
          error={missing('phone') ?? refused('phone')}
        />
        {problem && !problem.ok ? (
          <p className="ac-note ac-warn" role="alert">
            <Icon name="info" />
            <span>{t(problem.reason === 'limit' ? 'limit' : 'failed')}</span>
          </p>
        ) : null}
        <div className="ac-acts">
          <button className="btn" type="submit" disabled={pending}>
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
