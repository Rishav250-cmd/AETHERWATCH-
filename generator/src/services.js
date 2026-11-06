export const serviceDefinitions = Object.freeze({
  frontend: Object.freeze({ baseMedianMs: 5, baseErrorRate: 0.005, host: 'frontend-1' }),
  cart: Object.freeze({ baseMedianMs: 12, baseErrorRate: 0.005, host: 'cart-api-1' }),
  payment: Object.freeze({ baseMedianMs: 60, baseErrorRate: 0.01, host: 'payment-api-1' }),
  'fraud-check': Object.freeze({ baseMedianMs: 25, baseErrorRate: 0.005, host: 'fraud-worker-1' }),
  db: Object.freeze({ baseMedianMs: 8, baseErrorRate: 0.003, host: 'ledger-db:5432' }),
  notify: Object.freeze({ baseMedianMs: 15, baseErrorRate: 0.005, host: 'notify-worker-1' }),
});

export const callGraph = Object.freeze({
  frontend: Object.freeze(['cart', 'payment', 'notify', 'db']),
  cart: Object.freeze(['db']),
  payment: Object.freeze(['fraud-check', 'db']),
  'fraud-check': Object.freeze([]),
  db: Object.freeze([]),
  notify: Object.freeze([]),
});
