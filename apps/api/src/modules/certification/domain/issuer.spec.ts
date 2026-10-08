import {
  acceptsNewCertificates,
  activate,
  approveReactivation,
  closeToNew,
  derecognise,
  newIssuer,
  requestReactivation,
  type ExpertApproval,
  type IssuerRecord,
} from './issuer';

const ref = (reference: string): ExpertApproval => ({ confirmedBy: 'expert-1', reference });
const val = (r: { ok: boolean; value?: IssuerRecord }): IssuerRecord => {
  if (!r.ok) throw new Error('expected ok');
  return r.value!;
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code);

const active = (): IssuerRecord => val(activate(newIssuer(), ref('doc-1')));

describe('issuer state machine', () => {
  it('starts proposed and activates only with an expert reference', () => {
    expect(newIssuer().state).toBe('proposed');
    expect(code(activate(newIssuer(), { confirmedBy: '', reference: 'x' }))).toBe(
      'issuer.expert-approval-required',
    );
    expect(code(activate(newIssuer(), { confirmedBy: 'e', reference: ' ' }))).toBe(
      'issuer.expert-approval-required',
    );
    expect(code(activate(newIssuer(), null as never))).toBe('issuer.expert-approval-required');
    expect(active().state).toBe('active');
    expect(acceptsNewCertificates('active')).toBe(true);
    for (const s of ['proposed', 'closed-to-new', 'derecognised'] as const) {
      expect(acceptsNewCertificates(s)).toBe(false);
    }
  });

  it('refuses activation from any other state', () => {
    expect(code(activate(active(), ref('doc-2')))).toBe('issuer.transition-forbidden');
  });

  it('closes an active issuer to new submissions only', () => {
    expect(val(closeToNew(active())).state).toBe('closed-to-new');
    expect(code(closeToNew(newIssuer()))).toBe('issuer.transition-forbidden');
  });

  it('derecognises from active or closed-to-new with the exact affected count', () => {
    expect(val(derecognise(active(), 3, 3)).state).toBe('derecognised');
    expect(val(derecognise(val(closeToNew(active())), 0, 0)).state).toBe('derecognised');
    expect(code(derecognise(active(), 2, 3))).toBe('issuer.confirmation-count-mismatch');
    expect(code(derecognise(active(), -1, -1))).toBe('issuer.confirmation-count-mismatch');
    expect(code(derecognise(active(), 1.5, 1.5))).toBe('issuer.confirmation-count-mismatch');
    expect(code(derecognise(newIssuer(), 0, 0))).toBe('issuer.transition-forbidden');
  });

  it('derecognised is terminal', () => {
    const d = val(derecognise(active(), 0, 0));
    expect(code(closeToNew(d))).toBe('issuer.transition-forbidden');
    expect(code(activate(d, ref('doc-9')))).toBe('issuer.transition-forbidden');
    expect(code(requestReactivation(d, 'a1', ref('doc-9')))).toBe('issuer.transition-forbidden');
    expect(code(derecognise(d, 0, 0))).toBe('issuer.transition-forbidden');
  });

  describe('reactivation by a second admin (H1)', () => {
    const closed = (): IssuerRecord => val(closeToNew(active()));

    it('needs a new reference, and stays closed until approved', () => {
      expect(code(requestReactivation(closed(), 'a1', ref('doc-1')))).toBe(
        'issuer.expert-approval-not-new',
      );
      const pending = val(requestReactivation(closed(), 'a1', ref('doc-2')));
      expect(pending.state).toBe('closed-to-new');
      expect(acceptsNewCertificates(pending.state)).toBe(false);
      expect(code(requestReactivation(pending, 'a2', ref('doc-3')))).toBe(
        'issuer.reactivation-pending',
      );
    });

    it('treats a re-typed old reference as not new, and an empty requester as invalid (Hassan L2, I1)', () => {
      for (const r of ['DOC-1', ' doc-1 ', 'ｄｏｃ-1']) {
        expect(code(requestReactivation(closed(), 'a1', ref(r)))).toBe(
          'issuer.expert-approval-not-new',
        );
      }
      expect(code(requestReactivation(closed(), ' ', ref('doc-2')))).toBe('approval.same-admin');
      const p = val(requestReactivation(closed(), 'a1', ref(' doc-2 ')));
      expect(p.reactivation?.expertApproval.reference).toBe('doc-2');
    });

    it('refuses the requester as approver and a missing request', () => {
      const pending = val(requestReactivation(closed(), 'a1', ref('doc-2')));
      expect(code(approveReactivation(pending, 'a1'))).toBe('approval.same-admin');
      expect(code(approveReactivation(closed(), 'a2'))).toBe('issuer.reactivation-not-requested');
    });

    it('a second admin activates it with the new reference', () => {
      const pending = val(requestReactivation(closed(), 'a1', ref('doc-2')));
      const a = val(approveReactivation(pending, 'a2'));
      expect(a.state).toBe('active');
      expect(a.expertApproval?.reference).toBe('doc-2');
      expect(a.reactivation).toBeNull();
    });

    it('cannot be requested from active or proposed', () => {
      expect(code(requestReactivation(active(), 'a1', ref('doc-2')))).toBe(
        'issuer.transition-forbidden',
      );
      expect(code(approveReactivation(active(), 'a2'))).toBe('issuer.transition-forbidden');
    });

    it('derecognising clears a pending request', () => {
      const pending = val(requestReactivation(closed(), 'a1', ref('doc-2')));
      expect(val(derecognise(pending, 0, 0)).reactivation).toBeNull();
    });
  });
});
