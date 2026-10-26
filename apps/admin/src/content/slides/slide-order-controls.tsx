'use client';

import { Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { usePositionLabel } from './slide-labels.tsx';
import {
  isScope,
  isValidScopeId,
  orderPageHref,
  scopesOf,
  type OrderPlace,
} from './slide-order.ts';
import { SLIDE_POSITIONS, type SlideScope } from './slide-types.ts';

/**
 * Which list to show: the position, and for a position that takes one, the scope with the id of
 * the item. A position or a scope of `all` opens at once; a scope that needs an id opens when the
 * id is entered and "Show order" is pressed.
 */
export function SlideOrderControls({ place }: { readonly place: OrderPlace }) {
  const t = useTranslations('content.slides.order');
  const scopeText = useTranslations('content.slides.placement');
  const router = useRouter();
  const positionLabel = usePositionLabel();
  const [position, setPosition] = useState(place.position);
  const [scope, setScope] = useState<SlideScope>(place.scope);
  const [idText, setIdText] = useState(place.scopeId ?? '');
  const [invalid, setInvalid] = useState(false);
  const scopes = scopesOf(position);

  function open(next: OrderPlace) {
    router.push(orderPageHref(next));
  }

  function changePosition(key: string) {
    const nextScope = scopesOf(key).includes(scope) ? scope : 'all';
    setPosition(key);
    setScope(nextScope);
    setIdText('');
    setInvalid(false);
    if (nextScope === 'all') open({ position: key, scope: 'all', scopeId: null });
  }

  function changeScope(value: string) {
    const next = isScope(value) && scopes.includes(value) ? value : 'all';
    setScope(next);
    setIdText('');
    setInvalid(false);
    if (next === 'all') open({ position, scope: 'all', scopeId: null });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (scope === 'all') {
      open({ position, scope, scopeId: null });
      return;
    }
    if (!isValidScopeId(idText)) {
      setInvalid(true);
      return;
    }
    open({ position, scope, scopeId: idText.trim().toLowerCase() });
  }

  return (
    <form
      role="search"
      aria-label={t('controls')}
      noValidate
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="w-full sm:w-64">
        <Select
          label={t('position')}
          value={position}
          options={SLIDE_POSITIONS.map((entry) => ({
            value: entry.key,
            label: positionLabel(entry.key),
          }))}
          onChange={(event) => changePosition(event.target.value)}
        />
      </div>
      {scopes.length > 1 ? (
        <div className="w-full sm:w-56">
          <Select
            label={t('scope')}
            value={scope}
            options={scopes.map((entry) => ({
              value: entry,
              label: scopeText(`scope.${entry}`),
            }))}
            onChange={(event) => changeScope(event.target.value)}
          />
        </div>
      ) : null}
      {scope === 'all' ? null : (
        <>
          <div className="w-full sm:w-96">
            <TextField
              label={scopeText(`scope-id.${scope}`)}
              value={idText}
              autoComplete="off"
              spellCheck={false}
              error={invalid ? t('scope-id-invalid') : undefined}
              onChange={(event) => {
                setIdText(event.target.value);
                setInvalid(false);
              }}
            />
          </div>
          <Button type="submit" variant="secondary">
            {t('show')}
          </Button>
        </>
      )}
    </form>
  );
}
