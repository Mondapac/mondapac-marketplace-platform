import type { Mock } from 'vitest';

type Answer = unknown;

/**
 * Answers the Exclusive perks calls by route (the two cards load in an order the test should not
 * depend on): the discount list, the cashback list and the writes, each a queue whose last list
 * answer repeats. A list left out answers an empty page.
 */
export function servePerks(
  call: Mock,
  answers: { discount?: Answer[]; cashback?: Answer[]; writes?: Answer[] },
): void {
  const empty = { ok: true, status: 200, body: { items: [] } };
  const lists = {
    discount: [...(answers.discount ?? [empty])],
    cashback: [...(answers.cashback ?? [empty])],
  };
  const writes = [...(answers.writes ?? [])];
  call.mockImplementation((method: string, path: string) => {
    if (method !== 'GET') return Promise.resolve(writes.shift() ?? empty);
    const queue = path.includes('type=CASHBACK') ? lists.cashback : lists.discount;
    return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
  });
}
