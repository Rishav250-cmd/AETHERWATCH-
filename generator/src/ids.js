function randomHex(prng, length) {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += prng.int(0, 15).toString(16);
  }
  return value;
}

export function traceId(prng) {
  return randomHex(prng, 32);
}

export function spanId(prng) {
  return randomHex(prng, 16);
}

export function createIdGenerator(prng) {
  return {
    traceId: () => traceId(prng),
    spanId: () => spanId(prng),
  };
}
