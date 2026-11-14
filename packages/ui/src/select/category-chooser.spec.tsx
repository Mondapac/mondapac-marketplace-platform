// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryChooser, type CategoryChooserLabels } from './category-chooser.tsx';
import type { CategoryChoice } from './category-chooser-logic.ts';

const labels: CategoryChooserLabels = {
  legend: 'Categories',
  hint: "Choose a category or subcategory. Products can't go on a department or group.",
  general: 'General',
  primary: 'Primary',
  hidden: 'Hidden',
  makePrimary: (name) => `Make ${name} the primary category`,
  makePrimaryText: 'Make primary',
  remove: (name) => `Remove ${name}`,
  removeText: 'Remove',
  add: 'Add a category',
  addPlaceholder: 'Search categories',
  empty: 'No category chosen yet.',
  limitReached: 'A product can be in up to 3 categories.',
  loading: 'Loading…',
  loadError: "We couldn't load the categories.",
  retry: 'Try again',
  search: 'Search categories',
  noResults: 'No category matches.',
  added: (name) => `Added ${name}.`,
  removed: (name) => `Removed ${name}.`,
  madePrimary: (name) => `${name} is now primary.`,
};
const mk = (id: string, path: string[], over: Partial<CategoryChoice> = {}): CategoryChoice => ({
  id,
  level: path.length,
  name: path[path.length - 1] ?? '',
  path,
  general: false,
  status: 'active',
  ...over,
});
const CHOICES = [
  mk('basmati', ['Pantry', 'Rice', 'Basmati']),
  mk('rice', ['Pantry', 'Rice'], { general: true }),
  mk('oils', ['Pantry', 'Oils']),
  mk('tea', ['Drinks', 'Tea']),
  mk('coffee', ['Drinks', 'Coffee'], { status: 'hidden' }),
];

function Harness({
  initial = [],
  onValue,
  ...rest
}: {
  initial?: string[];
  onValue?: (ids: string[]) => void;
} & Partial<React.ComponentProps<typeof CategoryChooser>>) {
  const [ids, setIds] = useState<string[]>(initial);
  return (
    <CategoryChooser
      choices={CHOICES}
      labels={labels}
      {...rest}
      value={ids}
      onChange={(next) => {
        setIds(next);
        onValue?.(next);
      }}
    />
  );
}

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const open = () => fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));

describe('CategoryChooser', () => {
  it('shows the hint, an empty line and a labelled add control', () => {
    render(<Harness />);
    expect(screen.getByRole('group', { name: 'Categories' })).toBeTruthy();
    expect(
      screen.getByText(
        "Choose a category or subcategory. Products can't go on a department or group.",
      ),
    ).toBeTruthy();
    expect(screen.getByText('No category chosen yet.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Add a category' })).toBeTruthy();
  });

  it('offers the path, "General" for the category itself and Hidden for a hidden one', async () => {
    render(<Harness />);
    open();
    expect(await screen.findByRole('option', { name: /^Pantry › Rice › Basmati/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Pantry › Rice › General/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Drinks › Coffee\s*Hidden/ })).toBeTruthy();
  });

  it('adds a category; the first one is the primary', async () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);
    open();
    fireEvent.click(await screen.findByRole('option', { name: /^Drinks › Tea/ }));
    expect(seen).toHaveBeenLastCalledWith(['tea']);
    const list = screen.getByRole('list');
    expect(within(list).getByText('Drinks › Tea')).toBeTruthy();
    expect(within(list).getByText('Primary')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Make .* the primary/ })).toBeNull();
  });

  it('makes another category primary and removes one, in the submitted order', () => {
    const seen = vi.fn();
    render(<Harness initial={['tea', 'oils', 'basmati']} onValue={seen} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Make Pantry › Oils the primary category' }),
    );
    expect(seen).toHaveBeenLastCalledWith(['oils', 'tea', 'basmati']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pantry › Oils' }));
    expect(seen).toHaveBeenLastCalledWith(['tea', 'basmati']);
  });

  it('stops at three and says so, then offers the add control again after a remove', () => {
    render(<Harness initial={['tea', 'oils', 'basmati']} />);
    expect(screen.getByText('A product can be in up to 3 categories.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Add a category' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pantry › Oils' }));
    expect(screen.getByRole('combobox', { name: 'Add a category' })).toBeTruthy();
  });

  it('names a chosen category the picker does not offer, and ties errors to their rows', () => {
    render(
      <Harness
        initial={['gone', 'tea']}
        nameOf={(id) => (id === 'gone' ? 'Old shelf' : id)}
        error="Choose at least one category."
        itemErrors={{
          0: "Choose a category or subcategory. Products can't go on a department or group.",
        }}
      />,
    );
    expect(screen.getByText('Old shelf')).toBeTruthy();
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent);
    expect(alerts).toContain('Choose at least one category.');
    expect(alerts).toContain(
      "Choose a category or subcategory. Products can't go on a department or group.",
    );
  });

  it('fires onOpen when focus enters the add control, and shows a load error with retry', () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    render(<Harness onOpen={onOpen} onRetry={onRetry} failed choices={[]} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(onOpen).toHaveBeenCalled();
    open();
    expect(screen.getByText("We couldn't load the categories.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('says what changed in a polite live region', () => {
    render(<Harness announcement="Added Drinks › Tea." />);
    expect(screen.getByRole('status').textContent).toBe('Added Drinks › Tea.');
  });
});
