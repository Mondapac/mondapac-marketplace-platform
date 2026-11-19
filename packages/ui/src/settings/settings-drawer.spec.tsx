import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsDrawer, type SettingsDrawerLabels } from './settings-drawer.tsx';

const labels: SettingsDrawerLabels = {
  close: 'Close',
  cancel: 'Cancel',
  submit: 'Save location',
  discardTitle: 'Discard your input?',
  discardMessage: 'Not saved.',
  keepEditing: 'Keep editing',
  discard: 'Discard',
};
const noop = () => undefined;
const html = (open: boolean, extra: { pending?: boolean } = {}) =>
  renderToStaticMarkup(
    <SettingsDrawer
      open={open}
      onClose={noop}
      onSubmit={noop}
      title="Edit location"
      description="Where you keep stock."
      notice={<p>Notice here</p>}
      labels={labels}
      {...extra}
    >
      <label>
        Name <input name="name" />
      </label>
    </SettingsDrawer>,
  );

describe('SettingsDrawer', () => {
  it('is a modal dialog named by its title, with the description and the notice above the fields', () => {
    const out = html(true);
    expect(out).toMatch(/<dialog[^>]*aria-labelledby=/);
    expect(out).toContain('Edit location');
    expect(out).toContain('Where you keep stock.');
    expect(out.indexOf('Notice here')).toBeLessThan(out.indexOf('name="name"'));
  });

  it('puts Cancel before the primary verb in the footer, after the close button in the header', () => {
    const out = html(true);
    const close = out.indexOf('aria-label="Close"');
    const cancel = out.indexOf('>Cancel<');
    const verb = out.indexOf('>Save location<');
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeLessThan(cancel);
    expect(cancel).toBeLessThan(verb);
    expect(out).toMatch(/<button[^>]*type="submit"[^>]*>(<[^>]*>)*Save location/);
  });

  it('renders nothing inside while closed', () => {
    const out = html(false);
    expect(out).not.toContain('Edit location');
    expect(out).not.toContain('name="name"');
  });

  it('opens from the inline-end edge and is full width on phones', () => {
    const out = html(true);
    expect(out).toContain('ms-auto');
    expect(out).toContain('w-full');
    expect(out).toContain('xl:w-(--mp-size-sheet-wide)');
  });
});
