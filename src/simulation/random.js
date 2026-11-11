// mulberry32 seeded rng from https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript
export const createRandomGenerator = (seed) => {
  let state = Number(seed) >>> 0;

  return () => {
    let value = state += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

// Named streams keep environmental draws independent of policy decisions.
export const createRandomStreams = (seed) => Object.fromEntries(
  ['bandwidth', 'freeRiders', 'churn', 'policy'].map((name, index) =>
    [name, createRandomGenerator((Number(seed) ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0)]),
);

