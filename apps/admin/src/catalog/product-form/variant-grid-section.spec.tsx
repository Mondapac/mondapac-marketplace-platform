// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { NO_VARIANT_FIELDS, type VariantRow } from './draft-content.ts';
import type { FormField } from './types.ts';
import { VariantGridSection } from './variant-grid-section.tsx';

const select = (code: string, name: string, options: readonly [string, string][]): FormField => ({
  code,
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption: true,
  bounds: {},
  names: { en: name },
  options: options.map(([value, label]) => ({ code: value, labels: { en: label } })),
});
const FIELDS = [
  select('size', 'Size', [
    ['s', 'Small'],
    ['l', 'Large'],
  ]),
  select('colour', 'Colour', [['red', 'Red']]),
];
const row = (
  key: string,
  options: Record<string, string>,
  state: VariantRow['state'],
): VariantRow => ({
  variantId: state === 'new' ? null : key,
  key,
  state,
  options,
  labels: {},
  ...NO_VARIANT_FIELDS,
});

function mount(props: {
  rows?: VariantRow[];
  axes?: string[];
  locked?: boolean;
  max?: number;
  galleryIds?: string[];
  notices?: string[];
}) {
  const onChange = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <VariantGridSection
        rows={props.rows ?? []}
        fields={FIELDS}
        axes={props.axes ?? []}
        locked={props.locked ?? false}
        defaultLocale="en"
        max={props.max ?? 10}
        refused={[]}
        productId="p1"
        galleryIds={props.galleryIds ?? []}
        notices={props.notices ?? []}
        onChange={onChange}
      />
    </NextIntlClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the variant grid of the platform product form', () => {
  it('lists the variant attributes of the feature set as axes', () => {
    mount({ axes: ['size', 'colour'] });
    expect(screen.getAllByRole('checkbox', { name: /Size|Colour/ })).toHaveLength(2);
    // Both axes are on, so neither can be switched on a third time; nothing else is offered.
    expect(
      screen.queryByText('This product’s feature set has no option that can vary.'),
    ).toBeNull();
  });

  it('warns when the variant limit is reached', () => {
    const onChange = mount({ axes: ['size'], rows: [row('a', { size: 's' }, 'new')], max: 1 });
    const ticks = screen.getAllByRole('checkbox', { name: 'Small' });
    expect(ticks.length).toBeGreaterThan(0);
    expect(screen.getByText(/You have reached the limit of 1 variants/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('asks before it removes a variant the server already knows, and removes it on confirm', () => {
    const onChange = mount({ axes: ['size'], rows: [row('v1', { size: 's' }, 'published')] });
    const combo = screen.getAllByRole('checkbox', { name: 'Small' }).at(-1)!;
    fireEvent.click(combo);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Remove this variant?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenCalledWith({ rows: [], axes: ['size'] });
  });

  it('removes a row that was only ticked in this form without asking', () => {
    const onChange = mount({ axes: ['size'], rows: [row('new-1', { size: 's' }, 'new')] });
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Small' }).at(-1)!);
    expect(onChange).toHaveBeenCalledWith({ rows: [], axes: ['size'] });
  });

  it('locks the axes once the product is published', () => {
    mount({ axes: ['size'], locked: true });
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Size' }).disabled).toBe(true);
  });

  it('shows barcode, shipping and photo picks of a ticked variant and writes them to the row', () => {
    const onChange = mount({
      axes: ['size'],
      rows: [row('v1', { size: 's' }, 'published')],
      galleryIds: ['img-1', 'img-2'],
    });
    fireEvent.change(screen.getByLabelText(/Barcode \(GTIN\)/), {
      target: { value: '4006381333931' },
    });
    expect((onChange.mock.calls.at(-1)![0] as { rows: VariantRow[] }).rows[0]!.gtin).toBe(
      '4006381333931',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Photo 2' }));
    expect((onChange.mock.calls.at(-1)![0] as { rows: VariantRow[] }).rows[0]!.imageIds).toEqual([
      'img-2',
    ]);
  });

  it('tells the admin about a barcode another product already carries', () => {
    mount({ axes: ['size'], rows: [row('v1', { size: 's' }, 'published')], notices: ['v1'] });
    expect(screen.getByText(/already used by another product/)).toBeTruthy();
  });
});
