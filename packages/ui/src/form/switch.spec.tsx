// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Switch } from './switch.tsx';

describe('Switch', () => {
  it('is a named switch that reports its state', () => {
    const on = renderToStaticMarkup(
      <Switch checked aria-label="Active" onCheckedChange={() => undefined} />,
    );
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-label="Active"');
    expect(on).toContain('type="button"');
    const off = renderToStaticMarkup(
      <Switch checked={false} aria-label="Active" onCheckedChange={() => undefined} />,
    );
    expect(off).toContain('aria-checked="false"');
  });

  it('can be disabled, and places the knob with logical flex edges', () => {
    const html = renderToStaticMarkup(
      <Switch checked disabled aria-label="Active" onCheckedChange={() => undefined} />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('justify-end');
    expect(html).not.toMatch(/\b(left|right|ml|mr|pl|pr)-/);
  });

  describe('in the browser', () => {
    afterEach(cleanup);

    const setup = (checked: boolean, disabled = false) => {
      const onCheckedChange = vi.fn();
      render(
        <Switch
          checked={checked}
          disabled={disabled}
          aria-label="Active"
          onCheckedChange={onCheckedChange}
        />,
      );
      return { onCheckedChange, toggle: screen.getByRole('switch', { name: 'Active' }) };
    };

    it('asks for the opposite state on a click, from off and from on', async () => {
      const off = setup(false);
      await userEvent.click(off.toggle);
      expect(off.onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
      cleanup();
      const on = setup(true);
      await userEvent.click(on.toggle);
      expect(on.onCheckedChange).toHaveBeenCalledExactlyOnceWith(false);
    });

    it('does nothing when disabled', async () => {
      const { onCheckedChange, toggle } = setup(false, true);
      expect(toggle.hasAttribute('disabled')).toBe(true);
      await userEvent.click(toggle);
      toggle.focus();
      await userEvent.keyboard(' ');
      await userEvent.keyboard('{Enter}');
      expect(onCheckedChange).not.toHaveBeenCalled();
    });

    it('toggles once with Space and once with Enter, as a native button does', async () => {
      const { onCheckedChange, toggle } = setup(false);
      toggle.focus();
      await userEvent.keyboard(' ');
      expect(onCheckedChange).toHaveBeenCalledTimes(1);
      expect(onCheckedChange).toHaveBeenLastCalledWith(true);
      await userEvent.keyboard('{Enter}');
      expect(onCheckedChange).toHaveBeenCalledTimes(2);
      expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    });

    it('paints the off track with the muted token and the on track with the accent', () => {
      const off = setup(false).toggle;
      expect(off.classList.contains('bg-fg-muted')).toBe(true);
      expect(off.classList.contains('bg-accent')).toBe(false);
      cleanup();
      const on = setup(true).toggle;
      expect(on.classList.contains('bg-accent')).toBe(true);
      expect(on.classList.contains('bg-fg-muted')).toBe(false);
    });
  });
});
