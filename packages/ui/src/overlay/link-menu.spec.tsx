// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkMenu } from './link-menu.tsx';

afterEach(cleanup);

const items = [
  { id: 'all', label: 'All sellers', href: '/sellers' },
  { id: 'look', label: 'Sellers that need a look', href: '/sellers/needs-a-look', count: 3 },
  {
    id: 'owner',
    label: 'Sellers without an owner',
    href: '/sellers/without-owner',
    count: 2,
    current: true,
  },
];

const open = (badge = { text: '5', accessibleName: 'Queues, 5 items need attention' }) => {
  render(
    <div>
      <LinkMenu label="Queues" items={items} badge={badge} />
      <button type="button">after</button>
    </div>,
  );
  return screen.getByRole('button', { name: 'Queues, 5 items need attention' });
};

describe('LinkMenu', () => {
  it('names the button with the count and exposes the menu-button state', () => {
    const button = open();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('has no badge and a plain name when none is given', () => {
    render(<LinkMenu label="Queues" items={items} badge={null} />);
    expect(screen.getByRole('button', { name: 'Queues' })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('opens on click, focuses the first item, and the items are real links with counts in their names', () => {
    fireEvent.click(open());
    const links = screen.getAllByRole('menuitem');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/sellers',
      '/sellers/needs-a-look',
      '/sellers/without-owner',
    ]);
    expect(document.activeElement).toBe(links[0]);
    expect(screen.getByRole('menuitem', { name: 'Sellers that need a look, 3' })).toBeTruthy();
    expect(links[2]?.getAttribute('aria-current')).toBe('page');
  });

  it('opens with ArrowDown on the button', () => {
    fireEvent.keyDown(open(), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('moves with arrows, Home and End, wrapping at the ends', () => {
    fireEvent.click(open());
    const links = screen.getAllByRole('menuitem');
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(links[0]);
  });

  it('closes on Escape and returns focus to the button', () => {
    const button = open();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on Tab and on a click outside', () => {
    const button = open();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByText('after'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('returns focus to the button on Tab, so Tab moves on from it', () => {
    const button = open();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(document.activeElement).toBe(button);
  });

  it('activates the focused link with Space', () => {
    fireEvent.click(open());
    const link = screen.getAllByRole('menuitem')[1] as HTMLAnchorElement;
    let clicked = false;
    link.addEventListener('click', (event) => {
      clicked = true;
      event.preventDefault();
    });
    link.focus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: ' ' });
    expect(clicked).toBe(true);
  });
});
