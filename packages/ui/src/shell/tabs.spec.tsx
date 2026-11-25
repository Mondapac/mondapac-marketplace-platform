// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs, tabIdOf } from './tabs.tsx';

afterEach(cleanup);

const items = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
];

function Switcher() {
  const [active, setActive] = useState('a');
  return (
    <>
      <Tabs label="Sections" items={items} activeId={active} onSelect={setActive} panelId="p" />
      <div id="p" role="tabpanel" aria-labelledby={tabIdOf('p', active)}>
        {active}
      </div>
    </>
  );
}

describe('Tabs', () => {
  it('draws a tab icon as decoration only: the label stays the name', () => {
    render(
      <Tabs
        label="Sections"
        items={[...items, { id: 'd', label: 'Cost', icon: 'lock' }]}
        activeId="a"
        onSelect={() => undefined}
        panelId="p"
      />,
    );
    const tab = screen.getByRole('tab', { name: 'Cost' });
    expect(tab.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('keeps toggle buttons without a panel id', () => {
    render(<Tabs label="Sections" items={items} activeId="b" onSelect={() => undefined} />);
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Beta' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('is an ARIA tab list with a panel id: one tab stop, arrow keys, Home and End', () => {
    render(<Switcher />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(alpha.getAttribute('aria-controls')).toBe('p');
    expect(alpha.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Beta' }).tabIndex).toBe(-1);
    expect(screen.getByRole('tabpanel', { name: 'Alpha' })).toBeTruthy();

    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Beta' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Beta' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('tabpanel', { name: 'Gamma' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Gamma' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
  });
});
