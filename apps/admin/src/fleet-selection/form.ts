import {
  FLEET_CODES,
  type FleetCode,
  type Kind,
  type Model,
  type Rule,
  type Weights,
} from './types.ts';

/** What the model form holds: texts for the numbers, the chosen fleets in their order. */
export interface ModelForm {
  readonly name: string;
  readonly kind: Kind;
  readonly weights: { readonly price: string; readonly eta: string; readonly reliability: string };
  readonly order: readonly FleetCode[];
}

export type FormField = 'name' | 'weights' | 'order';

export const EMPTY_FORM: ModelForm = {
  name: '',
  kind: 'cheapest',
  weights: { price: '50', eta: '30', reliability: '20' },
  order: ['mondapac_drive', 'uber_direct', 'zoom2u'],
};

export function formOf(model: Model): ModelForm {
  const { rule } = model;
  return {
    name: model.name,
    kind: rule.kind,
    weights: {
      price: String(rule.weights?.price ?? 0),
      eta: String(rule.weights?.eta ?? 0),
      reliability: String(rule.weights?.reliability ?? 0),
    },
    order: rule.order ?? EMPTY_FORM.order,
  };
}

const WHOLE = /^\d{1,3}$/;

function weightsOf(form: ModelForm['weights']): Weights | null {
  const values = [form.price, form.eta, form.reliability].map((text) => text.trim());
  if (!values.every((text) => WHOLE.test(text))) return null;
  const [price, eta, reliability] = values.map(Number) as [number, number, number];
  if (Math.max(price, eta, reliability) > 100 || price + eta + reliability === 0) return null;
  return { price, eta, reliability };
}

/** A score from 0 to 100 as a whole number, or null. */
export function scoreOf(text: string): number | null {
  const trimmed = text.trim();
  if (!WHOLE.test(trimmed)) return null;
  const score = Number(trimmed);
  return score <= 100 ? score : null;
}

export type Checked =
  | { readonly ok: true; readonly name: string; readonly rule: Rule }
  | { readonly ok: false; readonly invalid: readonly FormField[] };

/** The body to send, or the fields to flag. The API checks all of it again. */
export function checkForm(form: ModelForm): Checked {
  const invalid: FormField[] = [];
  const name = form.name.trim();
  if (name.length < 1 || name.length > 60) invalid.push('name');
  let rule: Rule = { kind: 'cheapest' };
  if (form.kind === 'weighted') {
    const weights = weightsOf(form.weights);
    if (weights === null) invalid.push('weights');
    else rule = { kind: 'weighted', weights };
  } else if (form.kind === 'fixed_priority') {
    if (form.order.length === 0) invalid.push('order');
    else rule = { kind: 'fixed_priority', order: form.order };
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, name, rule };
}

/** The listed fleets not yet chosen, in the fixed catalogue order. */
export const unchosen = (order: readonly FleetCode[], listed: readonly FleetCode[]): FleetCode[] =>
  FLEET_CODES.filter((fleet) => listed.includes(fleet) && !order.includes(fleet));

/** The order with the fleet at `index` moved by `by` places (-1 up, 1 down); unchanged at an end. */
export function moved(order: readonly FleetCode[], index: number, by: -1 | 1): FleetCode[] {
  const to = index + by;
  if (to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
