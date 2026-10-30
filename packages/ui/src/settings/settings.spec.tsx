import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsConflictBanner } from './conflict-banner.tsx';
import { SettingsErrorSummary } from './error-summary.tsx';
import { Button } from '../form/button.tsx';
import { NoAccess } from './no-access.tsx';
import { SaveBar } from './save-bar.tsx';
import {
  SettingCheckbox,
  SettingInput,
  SettingRow,
  SettingSelect,
  SettingTextArea,
} from './setting-row.tsx';
import { SettingsPage } from './settings-page.tsx';
import { SettingsSection } from './settings-section.tsx';
import { leavesPage, type ClickInfo } from './unsaved-changes-guard.tsx';

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const labels = {
  region: 'Unsaved changes',
  discard: 'Discard',
  save: 'Save changes',
  saving: 'Saving…',
};

describe('SettingRow', () => {
  it('names the control with a real label and ties help and error to it', () => {
    const out = html(
      <SettingRow label="Cut-off time" help="Brisbane time." error="Enter a time.">
        <SettingInput name="cutoff" />
      </SettingRow>,
    );
    const id = /<label id="[^"]+" for="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeDefined();
    expect(out).toContain(`id="${id}"`);
    expect(out).toContain(`aria-describedby="${id}-help ${id}-error"`);
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('>Enter a time.</p>');
    expect(out).toContain('border-critical-solid');
  });

  it('is two columns from 760 px and one column below it', () => {
    const out = html(
      <SettingRow label="Fee">
        <SettingInput />
      </SettingRow>,
    );
    expect(out).toContain('md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]');
    expect(out).toContain('grid gap-1.5');
  });

  it('marks a changed control with the attention ring, not a critical edge', () => {
    const out = html(
      <SettingRow label="Fee" changed>
        <SettingSelect options={[{ value: 'a', label: 'A' }]} />
      </SettingRow>,
    );
    expect(out).toContain('border-attention-solid');
    expect(out).toContain('ring-attention-border');
    expect(out).not.toContain('border-critical-solid');
  });

  it('lets an error win over the changed ring', () => {
    const out = html(
      <SettingRow label="Fee" changed error="Bad">
        <SettingInput />
      </SettingRow>,
    );
    expect(out).toContain('border-critical-solid');
    expect(out).not.toContain('border-attention-solid');
  });

  it('names a group with role group instead of a label', () => {
    const out = html(
      <SettingRow label="Days" group>
        <SettingCheckbox text="On" />
      </SettingRow>,
    );
    expect(out).toContain('role="group"');
    expect(out).not.toContain('<label');
  });

  it('shows a plain value without a label element', () => {
    const out = html(
      <SettingRow label="Current address" plain>
        <p>help@example.com</p>
      </SettingRow>,
    );
    expect(out).not.toContain('<label');
    expect(out).toContain('Current address');
  });

  it('disables the controls of a view-only row', () => {
    const out = html(
      <SettingRow label="Fee" disabled>
        <SettingInput />
      </SettingRow>,
    );
    expect(out).toContain('disabled=""');
  });

  it('refuses a control outside a row', () => {
    expect(() => html(<SettingInput />)).toThrow(/inside a SettingRow/);
  });
});

describe('SettingTextArea', () => {
  it('is named by the row, tied to its help, error and counter, and marked when changed', () => {
    const out = html(
      <SettingRow label="About" help="Plain text." error="Too long." changed>
        <SettingTextArea name="about" counter="11 of 10 characters" />
      </SettingRow>,
    );
    const id = /<label id="[^"]+" for="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeDefined();
    expect(out).toContain(`<textarea id="${id}"`);
    expect(out).toContain(`aria-describedby="${id}-help ${id}-error ${id}-counter"`);
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain(`<div id="${id}-counter"`);
    expect(out).toContain('>11 of 10 characters</div>');
  });

  it('is disabled with its row', () => {
    const out = html(
      <SettingRow label="About" disabled>
        <SettingTextArea name="about" />
      </SettingRow>,
    );
    expect(out).toMatch(/<textarea[^>]* disabled/);
  });

  it('marks a changed value with the attention ring', () => {
    const out = html(
      <SettingRow label="About" changed>
        <SettingTextArea name="about" />
      </SettingRow>,
    );
    expect(out).toContain('ring-attention-border');
  });
});

describe('SettingsSection', () => {
  it('is a labelled card with an h2 and a one-line description', () => {
    const out = html(
      <SettingsSection title="Customer fees" description="What the customer pays.">
        <p>rows</p>
      </SettingsSection>,
    );
    expect(out).toMatch(/<section aria-labelledby="([^"]+)"/);
    expect(out).toContain('<h2');
    expect(out).toContain('>Customer fees</h2>');
    expect(out).toContain('What the customer pays.');
    expect(out).toContain('border-line');
  });

  it('tones the danger variant critical', () => {
    const out = html(
      <SettingsSection title="Danger zone" variant="danger">
        <p>x</p>
      </SettingsSection>,
    );
    expect(out).toContain('border-critical-border');
    expect(out).toContain('text-critical-fg');
  });
});

describe('SettingsPage', () => {
  it('has one h1, the description, the last change with its history link, banner and actions', () => {
    const out = html(
      <SettingsPage
        title="Delivery rules"
        description="When delivery is offered."
        lastChanged={{
          text: 'Last changed by Sara K. · 2 days ago',
          historyHref: '/h',
          historyLabel: 'History',
        }}
        actions={<button type="button">Pin</button>}
        banner={<p>Banner</p>}
      >
        <p>sections</p>
      </SettingsPage>,
    );
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('When delivery is offered.');
    expect(out).toContain('Last changed by Sara K. · 2 days ago');
    expect(out).toContain('<a href="/h"');
    expect(out).toContain('Pin');
    expect(out.indexOf('Banner')).toBeLessThan(out.indexOf('sections'));
  });

  it('wraps the sections and the save bar in one form when given a submit handler', () => {
    const out = html(
      <SettingsPage title="T" onSubmit={() => {}} saveBar={<p>bar</p>}>
        <p>sections</p>
      </SettingsPage>,
    );
    expect(out).toMatch(/<form[^>]*noValidate/);
    expect(out.indexOf('sections')).toBeLessThan(out.indexOf('bar'));
    expect(html(<SettingsPage title="T">x</SettingsPage>)).not.toContain('<form');
  });
});

describe('SaveBar', () => {
  const bar = (props: Partial<Parameters<typeof SaveBar>[0]> = {}) =>
    html(
      <SaveBar
        count={2}
        summary="2 unsaved changes"
        labels={labels}
        onDiscard={() => {}}
        {...props}
      />,
    );

  it('renders nothing while nothing is unsaved', () => {
    expect(bar({ count: 0 })).toBe('');
  });

  it('is a sticky named region with the summary, Discard and a submit Save', () => {
    const out = bar();
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-label="Unsaved changes"');
    expect(out).toContain('sticky');
    expect(out).toContain('2 unsaved changes');
    expect(out).toContain('>Discard</button>');
    expect(out).toMatch(/<button type="submit"[^>]*>Save changes<\/button>/);
  });

  it('adds the errors to the summary and disables Save', () => {
    const out = bar({ errorCount: 1, errorsSummary: '1 needs fixing' });
    expect(out).toContain('1 needs fixing');
    expect(out).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('shows the saving label, keeps Save focusable and disables Discard', () => {
    const out = bar({ saving: true });
    expect(out).toContain('Saving…');
    expect(out).toContain('aria-busy="true"');
    expect(out).toMatch(/<button type="button"[^>]*disabled=""[^>]*>Discard/);
    expect(out).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('sits above the phone bottom bar for the seller', () => {
    expect(bar()).not.toContain('--mp-size-bottom-bar');
    expect(bar({ aboveBottomBar: true })).toContain('--mp-size-bottom-bar');
  });
});

describe('NoAccess and the conflict banner', () => {
  it('shows the access block as the page h1 with a way back', () => {
    const out = html(
      <NoAccess
        title="You don't have access to this page"
        body="Needs the permission."
        backHref="/"
        backLabel="Back to dashboard"
      />,
    );
    expect(out).toContain('<h1');
    expect(out).toContain('Needs the permission.');
    expect(out).toContain('<a');
    expect(out).toContain('href="/"');
    expect(out).toContain('Back to dashboard');
  });

  it('says who saved first, that changes are kept, and offers Compare only with a handler', () => {
    const base = {
      title: 'Sara K. saved these settings 1 minute ago',
      body: 'Your 2 changes are kept.',
    };
    const plain = html(<SettingsConflictBanner {...base} />);
    expect(plain).toContain('Sara K. saved these settings 1 minute ago');
    expect(plain).toContain('Your 2 changes are kept.');
    expect(plain).not.toContain('<button');
    expect(
      html(
        <SettingsConflictBanner {...base} compareLabel="Compare changes" onCompare={() => {}} />,
      ),
    ).toContain('Compare changes');
  });
});

describe('leavesPage', () => {
  const here = new URL('https://admin.example.com/settings?tab=1');
  const click = (over: Partial<ClickInfo> = {}): ClickInfo => ({
    button: 0,
    modified: false,
    href: 'https://admin.example.com/orders',
    target: '',
    download: false,
    ...over,
  });

  it('guards a plain click to another page of the app', () => {
    expect(leavesPage(click(), here)).toBe(true);
    expect(leavesPage(click({ href: '/orders?x=1' }), here)).toBe(true);
    expect(leavesPage(click({ href: '/settings?tab=2' }), here)).toBe(true);
  });

  it('leaves alone what does not leave this page or this window', () => {
    expect(leavesPage(click({ href: '/settings?tab=1#fees' }), here)).toBe(false);
    expect(leavesPage(click({ href: 'https://other.example.com/' }), here)).toBe(false);
    expect(leavesPage(click({ href: 'mailto:a@b.com' }), here)).toBe(false);
    expect(leavesPage(click({ target: '_blank' }), here)).toBe(false);
    expect(leavesPage(click({ download: true }), here)).toBe(false);
    expect(leavesPage(click({ modified: true }), here)).toBe(false);
    expect(leavesPage(click({ button: 1 }), here)).toBe(false);
    expect(leavesPage(click({ href: 'http://[bad' }), here)).toBe(false);
  });
});

describe('SettingsErrorSummary', () => {
  it('is a critical alert that links each invalid field', () => {
    const out = html(
      <SettingsErrorSummary
        title="2 settings need fixing before you can save"
        items={[
          { id: 'cutoff', label: 'Cut-off time' },
          { id: 'free', label: 'Free delivery from' },
        ]}
      />,
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain('2 settings need fixing before you can save');
    expect(out).toContain('<a href="#cutoff"');
    expect(out).toContain('>Free delivery from</a>');
    expect(out).toContain('text-critical-fg');
  });

  it('renders nothing without fields', () => {
    expect(html(<SettingsErrorSummary title="x" items={[]} />)).toBe('');
  });
});

describe('Button disabled state', () => {
  it('keeps every disabled label in a readable muted text colour, with no opacity fade', () => {
    for (const variant of ['primary', 'secondary', 'destructive', 'link'] as const) {
      const out = html(
        <Button variant={variant} disabled>
          Save
        </Button>,
      );
      expect(out).toContain('disabled:text-fg-muted');
      expect(out).not.toContain('opacity');
      expect(out).not.toContain('accent-disabled');
    }
    expect(html(<Button disabled>Save</Button>)).toContain('disabled:bg-muted');
  });
});
