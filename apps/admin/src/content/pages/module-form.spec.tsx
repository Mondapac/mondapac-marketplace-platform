// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { ModuleForm, type FieldCodes } from './module-form.tsx';
import { blankConfig, configOf } from './module-schema.ts';

/** The form with its state kept, reporting what would be sent after every change. */
function mount(
  module: string,
  start: Record<string, unknown> = blankConfig(module),
  errors: FieldCodes = new Map(),
) {
  const seen = vi.fn<(config: Record<string, unknown>) => void>();
  function Harness() {
    const [draft, setDraft] = useState(start);
    return (
      <ModuleForm
        module={module}
        draft={draft}
        errors={errors}
        onChange={(next) => {
          setDraft(next);
          seen(configOf(next));
        }}
      />
    );
  }
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <Harness />
    </NextIntlClientProvider>,
  );
  return () => seen.mock.calls.at(-1)?.[0];
}
const type = (label: RegExp | string, value: string, index = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[index]!, { target: { value } });
const press = (name: RegExp | string, index = 0) =>
  fireEvent.click(screen.getAllByRole('button', { name })[index]!);

afterEach(cleanup);

describe('the settings forms', () => {
  it('banner: a title, a ready-made picture with its description, a link and a button', () => {
    const last = mount('banner');
    type(/^Title/, 'Eid');
    type(/^Picture$/, 'fruits');
    type(/^Picture description/, 'Fruit');
    type(/^Link/, 'https://example.test/eid');
    type(/^Button text/, 'Shop');
    expect(last()).toEqual({
      title: 'Eid',
      image: { ref: 'fruits', alt: 'Fruit' },
      href: 'https://example.test/eid',
      ctaLabel: 'Shop',
    });
  });

  it('banner: an image the template put there stays selectable', () => {
    mount('banner', { title: 'x', image: { ref: 'campaign-default', alt: 'x' } });
    const picture = screen.getByLabelText<HTMLSelectElement>(/^Picture$/);
    expect(picture.value).toBe('campaign-default');
    expect(within(picture).getByText('campaign-default (set by the template)')).toBeTruthy();
  });

  it('category circles and sellers: keep the categories they were given, size the row', () => {
    const last = mount('category-circles', { title: 'Shop', categoryIds: ['a', 'b'] });
    type(/^Title/, 'Browse');
    expect(last()).toEqual({ title: 'Browse', categoryIds: ['a', 'b'] });
    cleanup();
    const sellers = mount('sellers-near-you');
    type(/^How many/, '6');
    expect(sellers()).toEqual({ limit: 6 });
  });

  it('product shelf: offers three sources, keeps another one set before, and sends only the kind it changes to', () => {
    const last = mount('product-shelf');
    expect(
      within(screen.getByLabelText(/^Products come from/))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Bestsellers', 'Specials', 'The page’s link']);
    type(/^Products come from/, 'specials');
    type(/^How many/, '8');
    expect(last()).toEqual({ source: { kind: 'specials' }, limit: 8 });
    cleanup();
    const manual = mount('product-shelf', {
      source: { kind: 'manual', productIds: ['p1'] },
      limit: 4,
    });
    expect(screen.getByText(/set before and is kept/)).toBeTruthy();
    type(/^How many/, '5');
    expect(manual()).toEqual({ source: { kind: 'manual', productIds: ['p1'] }, limit: 5 });
    type(/^Products come from/, 'bestsellers');
    expect(manual()).toEqual({ source: { kind: 'bestsellers' }, limit: 5 });
  });

  it('info strip: items with an icon, text and link, added, moved and removed within 1 to 4', () => {
    const last = mount('info-strip');
    type(/^Text/, 'Free delivery');
    press('Add item');
    type(/^Icon/, 'tax', 1);
    type(/^Text/, 'GST included', 1);
    expect(last()).toEqual({
      items: [
        { icon: 'delivery', text: 'Free delivery' },
        { icon: 'tax', text: 'GST included' },
      ],
    });
    press('Move Item 2 up', 0);
    expect((last()?.items as { icon: string }[]).map((item) => item.icon)).toEqual([
      'tax',
      'delivery',
    ]);
    press('Add item');
    press('Add item');
    expect(screen.getByText('At most 4.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add item' }).disabled).toBe(true);
    press(/^Remove Item 4/);
    expect(screen.getAllByText(/^Item \d$/)).toHaveLength(3);
  });

  it('the last item of a list cannot be removed', () => {
    mount('info-strip');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove Item 1' }).disabled).toBe(
      true,
    );
  });

  it('text block: a heading, a paragraph in parts with a link, and a list', () => {
    const last = mount('text-block');
    type(/^Block type/, 'heading');
    type(/^Heading level/, '3');
    type(/^Text/, 'Opening hours');
    press('Add block');
    type(/^Text/, 'Open daily', 1);
    type(/^Link/, '/contact', 0);
    press('Add text part', 0);
    type(/^Text/, 'Call us', 2);
    press('Add block');
    type(/^Block type/, 'list', 2);
    type(/^Text/, 'Fruit', 3);
    expect(last()).toEqual({
      blocks: [
        { type: 'heading', level: 3, text: 'Opening hours' },
        {
          type: 'paragraph',
          spans: [{ text: 'Open daily', href: '/contact' }, { text: 'Call us' }],
        },
        { type: 'list', items: [[{ text: 'Fruit' }]] },
      ],
    });
  });

  it('image and text: a picture, heading, text, side and a button', () => {
    const last = mount('image-text');
    type(/^Picture$/, 'bread');
    type(/^Picture description/, 'Bread');
    type(/^Heading/, 'Fresh');
    type(/^Text/, 'Baked daily');
    type(/^Picture side/, 'end');
    type(/^Button text/, 'Order');
    expect(last()).toEqual({
      image: { ref: 'bread', alt: 'Bread' },
      heading: 'Fresh',
      body: [{ text: 'Baked daily' }],
      imageSide: 'end',
      ctaLabel: 'Order',
    });
  });

  it('FAQ: questions with answers, in order', () => {
    const last = mount('faq');
    type(/^Question/, 'Halal?');
    type(/^Text/, 'Yes');
    press('Add item');
    type(/^Question/, 'Delivery?', 1);
    type(/^Text/, 'Daily', 1);
    press('Move Item 2 up');
    expect(last()).toEqual({
      items: [
        { question: 'Delivery?', answer: [{ text: 'Daily' }] },
        { question: 'Halal?', answer: [{ text: 'Yes' }] },
      ],
    });
  });

  it('brand header: a name, a description and an optional logo', () => {
    const last = mount('brand-header');
    type(/^Name/, 'Fresh Co');
    type(/^Description/, 'Local');
    expect(last()).toEqual({ name: 'Fresh Co', description: 'Local' });
    type(/^Picture$/, 'egg');
    type(/^Picture description/, 'Egg');
    expect(last()).toEqual({
      name: 'Fresh Co',
      description: 'Local',
      logo: { ref: 'egg', alt: 'Egg' },
    });
  });

  it('product spotlight: the optional text can be removed, and is then left out', () => {
    const last = mount('product-spotlight', { productId: 'p1', body: [{ text: '' }] });
    press('Remove Part 1');
    expect(last()).toEqual({ productId: 'p1' });
  });

  it('product spotlight: a heading and a text, and the product it keeps', () => {
    const last = mount('product-spotlight', { productId: 'p1', body: [{ text: '' }] });
    type(/^Heading/, 'Dates');
    type(/^Text/, 'Sweet');
    expect(last()).toEqual({ productId: 'p1', heading: 'Dates', body: [{ text: 'Sweet' }] });
  });
});

describe('refusals', () => {
  it('draws the refusal of an empty part on that part, not on its neighbour', () => {
    const last = mount(
      'faq',
      {
        items: [{ question: 'q1', answer: [{ text: '' }, { text: 'b', href: 'bad url' }] }],
      },
      new Map([['config.items[0].answer[1].href', 'format']]),
    );
    expect(screen.getAllByLabelText(/^Link/)[1]?.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByLabelText(/^Link/)[0]?.getAttribute('aria-invalid')).toBeNull();
    type(/^Question/, 'q1!');
    expect(last()).toEqual({
      items: [{ question: 'q1!', answer: [{}, { text: 'b', href: 'bad url' }] }],
    });
  });

  it('says a too-long link in the link words', () => {
    mount('banner', {}, new Map([['config.href', 'length']]));
    expect(screen.getByText('Use a site path such as /offers, or an https link.')).toBeTruthy();
  });

  it('shows each code in words on the field its path names', () => {
    mount(
      'banner',
      { title: 'x'.repeat(5), image: { ref: 'fruits', alt: '' }, href: 'nope' },
      new Map([
        ['config.title', 'length'],
        ['config.image.alt', 'required'],
        ['config.href', 'format'],
        ['config.ctaLabel', 'other'],
      ]),
    );
    expect(screen.getByLabelText(/^Title/).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use at most 80 characters.')).toBeTruthy();
    expect(screen.getByLabelText(/^Picture description/).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Fill this in.')).toBeTruthy();
    expect(screen.getByText('Use a site path such as /offers, or an https link.')).toBeTruthy();
    expect(screen.getByLabelText(/^Button text/).getAttribute('aria-invalid')).toBe('true');
  });

  it('marks the image when the API says it is missing as a whole', () => {
    mount('banner', {}, new Map([['config.image', 'required']]));
    expect(screen.getByLabelText(/^Picture$/).getAttribute('aria-invalid')).toBe('true');
  });

  it('marks a nested text by its indexed path', () => {
    mount(
      'faq',
      { items: [{ question: 'q', answer: [{ text: 'a' }] }] },
      new Map([['config.items[0].answer[0].text', 'length']]),
    );
    expect(screen.getByText('Use at most 1000 characters.')).toBeTruthy();
  });

  it('says a list is empty when the API wants at least one', () => {
    mount('info-strip', { items: [] }, new Map([['config.items', 'required']]));
    expect(screen.getByText('Add at least one.')).toBeTruthy();
  });
});
