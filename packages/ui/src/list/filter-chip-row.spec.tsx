import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../form/button.tsx';
import { FilterChipRow } from './filter-chip-row.tsx';

const chip = { key: 'a', label: 'Status is Inactive', removeLabel: 'Remove', onRemove: () => {} };

describe('FilterChipRow', () => {
  it('puts a divider between the chips and the actions, and the star apart from its label', () => {
    const html = renderToStaticMarkup(
      <FilterChipRow
        chips={[chip]}
        clearAll={{ label: 'Clear all', onClick: () => {} }}
        save={{ label: 'Save filter…', onClick: () => {} }}
        status="1 match"
      />,
    );
    expect(html).toContain('w-px');
    expect(html).toContain('Clear all');
    expect(html).toContain('Save filter…');
    expect(html).toContain('gap-1.5');
  });

  it('has no divider when there are no chips or no actions', () => {
    const none = renderToStaticMarkup(
      <FilterChipRow chips={[]} save={{ label: 'S', onClick: () => {} }} status="" />,
    );
    expect(none).not.toContain('w-px');
    const noActions = renderToStaticMarkup(<FilterChipRow chips={[chip]} status="" />);
    expect(noActions).not.toContain('w-px');
  });
});

describe('Button sm', () => {
  it('uses the compact control height and text-sm, with a gap for an icon', () => {
    const html = renderToStaticMarkup(
      <Button variant="quiet" size="sm">
        x
      </Button>,
    );
    expect(html).toContain('h-(--mp-size-control-sm)');
    expect(html).toContain('text-sm');
    expect(html).toContain('gap-1.5');
  });
});
