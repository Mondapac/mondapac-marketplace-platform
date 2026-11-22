// Pack "certificates": the halal certificates of the scenario's certified sellers, through the
// issuer registry, the seller's certificate page and the admin review, as people would. The admin
// adds the issuer and activates it with an expert approval reference; each certified seller starts
// a certificate, fills the draft, uploads a scan and submits it; the admin records the checks and
// the scope and approves it. Then the reviewer approves each certified seller in the culture that
// requires the type (ADR-0047; never without a valid certificate, the API refuses). Every value is
// marked as sample data. A rerun creates only what is missing.
import { certificateScan } from '../media.mjs';
import { settle, write } from './requests.mjs';

const ISSUER = {
  displayName: 'Sample Halal Certifier (test data)',
  accreditationNumber: 'SAMPLE-ACC-001',
  expertApproval: {
    confirmedBy: 'Operational test data',
    reference: 'scripts/ops-data: sample issuer for the local test environment',
  },
};

async function ensureIssuer(admin, reviewer, typeCode, log) {
  const types = await admin.ok('GET', '/certification/admin/types');
  const type = types.items.find((item) => item.code === typeCode);
  if (!type) throw new Error(`certification type ${typeCode} is not in the Market`);
  const list = await admin.ok('GET', '/certification/admin/issuers?pageSize=100');
  let issuer = (list.items ?? list.issuers ?? []).find(
    (item) => item.displayName === ISSUER.displayName && item.typeId === type.typeId,
  );
  if (!issuer) {
    const created = await admin.ok('POST', '/certification/admin/issuers', {
      typeId: type.typeId,
      displayName: ISSUER.displayName,
      accreditationNumber: ISSUER.accreditationNumber,
    });
    issuer = { issuerId: created.issuerId, state: created.state, version: created.version };
    log(`  issuer ${ISSUER.displayName} added`);
  }
  if (issuer.state !== 'active') {
    const pending = [];
    await write(
      admin,
      'POST',
      `/certification/admin/issuers/${issuer.issuerId}/activate`,
      { version: issuer.version, expertApproval: ISSUER.expertApproval },
      pending,
      'activate the sample issuer',
    );
    await settle(reviewer, pending, log);
  }
  return issuer.issuerId;
}

async function ensureCertificate(admin, session, seller, issuerId, log) {
  const { certificate } = seller;
  const list = await session.ok('GET', '/certification/seller/certificates');
  let row = list.certificates.find((item) => item.typeCode === certificate.type);
  if (row?.status === 'approved') return false;
  if (!row) {
    const created = await session.ok('POST', '/certification/seller/certificates', {
      typeCode: certificate.type,
    });
    row = created.certificate ?? created;
  }
  const id = row.certificateId;
  if (row.editable !== false) {
    await session.ok('PUT', `/certification/seller/certificates/${id}`, {
      issuerId,
      certificateNumber: certificate.number,
      issueDate: certificate.issueDate,
      expiryDate: certificate.expiryDate,
      selfDeclared: null,
      selfDeclarationNote: null,
    });
    const detail = await session.ok('GET', `/certification/seller/certificates/${id}`);
    if (detail.documents.length === 0) {
      await session.ok('POST', `/certification/seller/certificates/${id}/documents`, {
        data: await certificateScan({
          holder: seller.businessName,
          number: certificate.number,
          issuer: ISSUER.displayName,
          issueDate: certificate.issueDate,
          expiryDate: certificate.expiryDate,
        }),
      });
    }
    await session.ok('POST', `/certification/seller/certificates/${id}/submit`, {});
  }
  await review(admin, id, seller);
  log(`  ${seller.key}: ${certificate.type} certificate ${certificate.number} approved`);
  return true;
}

/** The admin review: every required check done, the scope read, then approve. */
async function review(admin, id, seller) {
  const base = `/certification/admin/seller-certificates/${id}`;
  const page = await admin.ok('GET', base);
  const submissionId = page.submission?.submissionId ?? page.submissionId;
  await admin.ok('POST', `${base}/scope`, {
    submissionId,
    location: `${seller.address.line1}, ${seller.address.suburb} ${seller.address.state} ${seller.address.postcode}`,
    scope: 'Retail sale of meat and poultry (sample data)',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await admin.ok('GET', base);
    const version = read.certificate?.version ?? read.version;
    const answer = await admin.request('POST', `${base}/approve`, { submissionId, version });
    if (answer.status === 200) return;
    if (answer.status === 422 && answer.body?.code === 'review.checks-incomplete') {
      for (const field of answer.body.details.fields) {
        await admin.ok('POST', `${base}/checks`, {
          submissionId,
          checkCode: field.path.replace(/^checks\./, ''),
          result: 'done',
        });
      }
      continue;
    }
    throw new Error(
      `${seller.key}: approve certificate -> ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`,
    );
  }
  throw new Error(`${seller.key}: the certificate checks did not complete`);
}

/** The reviewer approves each certified seller in the cultures whose type it now holds. */
async function ensureCultures(reviewer, sellerId, seller, log) {
  const { cultures } = await reviewer.ok('GET', `/sellers/admin/${sellerId}/cultures`);
  for (const culture of cultures) {
    if (culture.status !== 'requested' || culture.certificate !== 'held') continue;
    await reviewer.ok('POST', `/sellers/admin/${sellerId}/cultures/${culture.cultureId}/decision`, {
      decision: 'approve',
    });
    log(`  ${seller.key}: approved in culture ${culture.cultureCode}`);
  }
}

export async function certificatesPack({ admin, reviewer, scenario, state, sessions, log }) {
  const certified = scenario.sellers.filter(
    (seller) => seller.certificate !== null && sessions.has(seller.key),
  );
  if (certified.length === 0) return;
  const issuerId = await ensureIssuer(admin, reviewer, 'halal', log);
  let approved = 0;
  for (const seller of certified) {
    if (await ensureCertificate(admin, sessions.get(seller.key), seller, issuerId, log))
      approved += 1;
    await ensureCultures(reviewer, state.sellers[seller.key].sellerId, seller, log);
  }
  log(`  ${certified.length} certified sellers (${approved} certificates approved now)`);
}
