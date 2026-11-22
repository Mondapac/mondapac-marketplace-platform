// Maker-checker helpers shared by the packs (System requests, Admin Inbox). In a reviewed area a
// write either applies at once and still files a request for a second admin ("reviewed after"), or
// answers 202 with the request it filed and changes nothing until a second admin approves it. The
// loader's reviewer admin is that second admin; the author never approves their own request.

/** Every write in a reviewed area carries a note (Admin Inbox, reviewed after). */
export const NOTE = 'Operational test data (scripts/ops-data)';

/**
 * Collects a 202 answer (the request it filed) or an already-pending refusal (an earlier run filed
 * the same change and it still waits) into `pending`; true when the write waits.
 */
export function filed(answer, pending, label) {
  if (answer.status === 202 && answer.body?.request) {
    pending.push({ label, request: answer.body.request });
    return true;
  }
  if (answer.status === 409 && answer.body?.code === 'system-requests.already-pending') {
    pending.push({ label, request: { id: null, number: answer.body.details.pendingNumber } });
    return true;
  }
  return false;
}

/** A write that may wait for approval: the body, or null when it was filed for approval. */
export async function write(session, method, path, body, pending, label) {
  const answer = await session.request(method, path, body);
  if (filed(answer, pending, label)) return null;
  if (answer.status < 200 || answer.status > 299) {
    throw new Error(
      `${method} ${path} (${label}) -> ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`,
    );
  }
  return answer.body;
}

/** The id of an open request by its number (SR-n), from the reviewer's queue. */
async function requestIdOf(reviewer, number) {
  const list = await reviewer.ok('GET', '/system-requests/admin/requests?status=open&pageSize=100');
  const row = list.rows.find((item) => item.number === number);
  if (row === undefined) throw new Error(`SR-${number} is not in the open requests`);
  return row.id;
}

/**
 * Approves the requests the writes filed, as the reviewer admin. Without a reviewer the run stops
 * and names the requests that wait.
 */
export async function settle(reviewer, pending, log) {
  if (pending.length === 0) return;
  if (reviewer === null) {
    const list = pending.map((item) => `SR-${item.request.number} (${item.label})`).join(', ');
    throw new Error(
      `These changes wait for a second admin's approval: ${list}. ` +
        'The scenario has no reviewer admin yet, so the loader cannot approve them.',
    );
  }
  for (const item of pending.splice(0)) {
    if (item.request.id === null)
      item.request.id = await requestIdOf(reviewer, item.request.number);
    await reviewer.ok('POST', `/system-requests/admin/requests/${item.request.id}/approve`, {});
    log(`  approved SR-${item.request.number} (${item.label}) as the reviewer`);
  }
}

/**
 * The changes of an area that applied at once still sit in the reviewer's queue ("reviewed
 * after"); the reviewer approves them, as a second admin would, so the Admin Inbox starts clean.
 */
export async function approveOpen(reviewer, area, log) {
  if (reviewer === null) return;
  let approved = 0;
  for (;;) {
    const list = await reviewer.ok(
      'GET',
      `/system-requests/admin/requests?status=open&area=${area}&pageSize=100`,
    );
    const open = list.rows.filter((row) => row.status === 'open' && row.area === area);
    if (open.length === 0) break;
    for (const row of open) {
      await reviewer.ok('POST', `/system-requests/admin/requests/${row.id}/approve`, {});
      approved += 1;
    }
  }
  log(`  ${approved} reviewed-after ${area} changes approved by the reviewer`);
}
