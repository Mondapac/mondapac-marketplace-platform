// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TopbarIconButton } from './topbar-icon-button.tsx';

describe('TopbarIconButton', () => {
  it('names the button and links its tooltip, which carries the hint', () => {
    render(
      <TopbarIconButton label="Search" hint={<span>Ctrl K</span>}>
        <svg />
      </TopbarIconButton>,
    );
    const button = screen.getByRole('button', { name: 'Search' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.textContent).toBe('SearchCtrl K');
    expect(button.className).toContain('rounded-full');
  });

  it('hides the tooltip on Escape without moving focus, and shows it again after blur', async () => {
    const user = userEvent.setup();
    render(
      <TopbarIconButton label="Help">
        <svg />
      </TopbarIconButton>,
    );
    const button = screen.getByRole('button', { name: 'Help' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    await user.tab();
    expect(tip.getAttribute('data-dismissed')).toBe('false');
    await user.keyboard('{Escape}');
    expect(tip.getAttribute('data-dismissed')).toBe('true');
    expect(document.activeElement).toBe(button);
    await user.tab();
    expect(tip.getAttribute('data-dismissed')).toBe('false');
  });
});
