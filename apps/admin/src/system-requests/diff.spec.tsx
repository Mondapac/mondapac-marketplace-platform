// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { RequestedAction } from './diff.tsx';

type Values = Readonly<Record<string, unknown>>;
function show(before: Values | null, after: Values | null) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RequestedAction kind="catalog.brand" before={before} after={after} history={false} />
    </NextIntlClientProvider>,
  );
}
const HIDDEN = 'The details of this request are visible to admins who may review it.';
afterEach(cleanup);

describe('RequestedAction', () => {
  it('says who may see the details when the API sent no after, and shows nothing else', () => {
    show(null, null);
    expect(screen.getByText(HIDDEN)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'What the subject holds now' })).toBeNull();
  });

  it('leaves out the current values, without a hidden note, when only before is missing', () => {
    show(null, { action: 'delete' });
    expect(screen.getByText('Delete')).toBeTruthy();
    expect(screen.queryByText(HIDDEN)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What the subject holds now' })).toBeNull();
  });

  it('names the import action and lists its details', () => {
    show({ rows: 0 }, { action: 'import', rows: 120 });
    expect(screen.getByText('Import')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
  });

  it('names an unknown action by its own words, as inert text', () => {
    show({ name: 'Acme' }, { action: 'rebuild-index<b>' });
    expect(screen.getByText('Rebuild index<b>')).toBeTruthy();
    expect(screen.getByText('Acme')).toBeTruthy();
  });

  it('says so when the action itself is not named', () => {
    show({ name: 'Acme' }, { name: 'x' });
    expect(screen.getByText('Action not named')).toBeTruthy();
  });

  it('shows the target of a merge in the title', () => {
    show({ name: 'Acme' }, { action: 'merge', intoId: 'b-2', intoName: 'Acme Pty' });
    expect(screen.getByText('Merge into Acme Pty')).toBeTruthy();
    expect(screen.getByText('b-2')).toBeTruthy();
  });
});
