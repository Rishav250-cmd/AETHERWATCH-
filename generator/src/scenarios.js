export const scenarios = Object.freeze([
  Object.freeze({
    id: 'checkout',
    name: 'POST /checkout',
    method: 'POST',
    route: '/checkout',
    weight: 50,
    children: Object.freeze([
      Object.freeze({
        service: 'cart',
        name: 'GET /cart',
        children: Object.freeze([
          Object.freeze({ service: 'db', name: 'SELECT cart_items' }),
        ]),
      }),
      Object.freeze({
        service: 'payment',
        name: 'POST /charge',
        children: Object.freeze([
          Object.freeze({ service: 'fraud-check', name: 'POST /score' }),
          Object.freeze({ service: 'db', name: 'INSERT ledger' }),
        ]),
      }),
      Object.freeze({ service: 'notify', name: 'POST /send-receipt' }),
    ]),
  }),
  Object.freeze({
    id: 'cart-read',
    name: 'GET /cart',
    method: 'GET',
    route: '/cart',
    weight: 30,
    children: Object.freeze([
      Object.freeze({
        service: 'cart',
        name: 'GET /cart',
        children: Object.freeze([
          Object.freeze({ service: 'db', name: 'SELECT cart_items' }),
        ]),
      }),
    ]),
  }),
  Object.freeze({
    id: 'products-read',
    name: 'GET /products',
    method: 'GET',
    route: '/products',
    weight: 20,
    children: Object.freeze([
      Object.freeze({ service: 'db', name: 'SELECT products' }),
    ]),
  }),
]);

export function pickScenario(prng) {
  const totalWeight = scenarios.reduce((total, scenario) => total + scenario.weight, 0);
  let choice = prng.next() * totalWeight;

  for (const scenario of scenarios) {
    choice -= scenario.weight;
    if (choice < 0) {
      return scenario;
    }
  }

  return scenarios.at(-1);
}
