const UINT32_RANGE = 0x1_0000_0000;

function normalizeSeed(seed) {
  if (typeof seed === 'bigint') {
    return Number(BigInt.asUintN(32, seed));
  }

  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return Math.trunc(seed) >>> 0;
  }

  if (typeof seed === 'string') {
    let hash = 0x811c9dc5;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  throw new TypeError('seed must be a finite number, bigint, or string');
}

export function createPrng(seed) {
  let state = normalizeSeed(seed);
  let spareNormal;

  function next() {
    let value = state += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  function int(min, max) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError('int(min, max) requires safe integer bounds with min <= max');
    }

    const range = max - min + 1;
    if (range > UINT32_RANGE) {
      throw new RangeError('int(min, max) supports ranges up to 2^32');
    }

    return min + Math.floor(next() * range);
  }

  function pick(array) {
    if (!Array.isArray(array) || array.length === 0) {
      throw new RangeError('pick(array) requires a non-empty array');
    }
    return array[int(0, array.length - 1)];
  }

  function chance(probability) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError('chance(p) requires p between 0 and 1');
    }
    return next() < probability;
  }

  function lognormal(median, sigma = 0.55) {
    if (!Number.isFinite(median) || median <= 0) {
      throw new RangeError('lognormal(median, sigma) requires median > 0');
    }
    if (!Number.isFinite(sigma) || sigma < 0) {
      throw new RangeError('lognormal(median, sigma) requires sigma >= 0');
    }
    if (sigma === 0) {
      return median;
    }

    let normal;
    if (spareNormal !== undefined) {
      normal = spareNormal;
      spareNormal = undefined;
    } else {
      const firstUniform = Math.max(Number.MIN_VALUE, 1 - next());
      const secondUniform = next();
      const radius = Math.sqrt(-2 * Math.log(firstUniform));
      const angle = 2 * Math.PI * secondUniform;
      normal = radius * Math.cos(angle);
      spareNormal = radius * Math.sin(angle);
    }

    return median * Math.exp(sigma * normal);
  }

  return { next, int, pick, chance, lognormal };
}
