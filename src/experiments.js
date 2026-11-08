import { runExperiment } from './simulator.js';

export const runSweeps = (config, {
  seeds = [42, 43, 44],
  alphas = [0, 0.25, 0.5, 0.75, 1],
} = {}) => {
  const repetitions = seeds.map((seed) => {
    const reference = runExperiment({ ...config, seed, strategies: ['prop', 'unchoke'] });
    const comparisons = reference.results.map((result) => ({ family: 'reference', result }));
    const hybridResults = new Map();
    for (const family of ['selection-only', 'allocation-only', 'combined']) {
      for (const alpha of alphas) {
        const alphaS = family === 'allocation-only' ? 0 : alpha;
        const alphaB = family === 'selection-only' ? 0 : alpha;
        const key = `${alphaS}:${alphaB}`;
        if (!hybridResults.has(key)) {
          const experiment = runExperiment({
            ...config, seed, alphaS, alphaB, strategies: ['hybrid'],
            experimentalInputs: reference.inputs,
          });
          hybridResults.set(key, experiment.results[0]);
        }
        comparisons.push({ family, alpha, alphaS, alphaB, result: hybridResults.get(key) });
      }
    }
    return { seed, inputs: reference.inputs, comparisons };
  });
  return { schemaVersion: 1, config, seeds, alphas, repetitions };
};

export const exportExperiment = (experiment) => JSON.stringify(experiment, null, 2);
