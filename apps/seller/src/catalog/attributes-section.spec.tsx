// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { AttributesSection } from './attributes-section.tsx';
import type { FormField, ValueSuggestion } from './types.ts';

const field = (code: string, dataType: string): FormField => ({
  code,
  dataType,
  localizable: false,
  required: false,
  isVariantOption: false,
  bounds: {},
  names: { 'en-AU': code },
  options: [{ code: 'plain', labels: { 'en-AU': 'Plain' } }],
});

const open: ValueSuggestion = {
  id: '0190a000-0000-7000-8000-0000000000b1',
  attributeCode: 'flavour',
  label: 'Oat',
  status: 'open',
  optionCode: null,
  rejectReason: null,
  createdAt: '2026-11-03T10:00:00.000Z',
};

afterEach(() => cleanup());

describe('attributes section suggestions', () => {
  it('offers a suggestion on select and multi-select fields only, and notes an open one', () => {
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <AttributesSection
          fields={[
            field('flavour', 'select'),
            field('tags', 'multi-select'),
            field('notes', 'text'),
          ]}
          inputs={{}}
          locales={['en-AU']}
          defaultLocale="en-AU"
          refused={[]}
          onChange={vi.fn()}
          productId="0190a000-0000-7000-8000-0000000000a1"
          csrfToken="csrf-1"
          suggestions={[open]}
          onSuggested={vi.fn()}
        />
      </NextIntlClientProvider>,
    );
    // flavour has an open suggestion (a note, no button); tags offers one; the text field none.
    expect(screen.getByRole('status').textContent).toContain('Oat');
    expect(screen.getAllByRole('button', { name: 'Suggest a value' })).toHaveLength(1);
  });
});
