// Public API: callers provide valid inputs according to the simulation contract.
// Keep exports stable while implementation details live in focused modules.
export { BASE_UPLOAD_MBPS, BASE_DOWNLOAD_MBPS, PIECE_SIZE_MB, STRATEGY_COLOURS, STRATEGY_NAMES } from './simulation/constants.js';
export { createRandomGenerator, createRandomStreams } from './simulation/random.js';
export { createChurnSchedule, createExperimentalInputs } from './simulation/network.js';
export { selectReceivers, allocateBandwidth } from './simulation/policies.js';
export { limitDownloads } from './simulation/transfers.js';

import { createChurnSchedule, createExperimentalInputs, makeNetwork } from './simulation/network.js';
import { simulateStrategy } from './simulation/engine.js';

export const runExperiment = ({
  nodeConfigs,
  experimentalInputs,
  onStep,
  strategies = ['hybrid', 'prop', 'unchoke'],
  durationMinutes = 30,
  fileSizeMB,
  regularSlots = 3,
  optimisticSlots = 1,
  alphaS,
  alphaB,
  seed = 42,
  churnEnabled = false,
  meanOnlineSeconds = 300,
  meanOfflineSeconds = 30,
  heterogeneity = 0,
  freeRiderCount = 0,
  stepSeconds = 0.1,
  selectionIntervalSeconds = 10,
  contributionWindowSeconds = 20,
  timeLimitSeconds = durationMinutes * 60,
}) => {
  const toSteps = (seconds) => Math.round(seconds / stepSeconds);
  const numberOfSteps = toSteps(timeLimitSeconds);
  const selectionSteps = toSteps(selectionIntervalSeconds);
  const contributionSteps = toSteps(contributionWindowSeconds);
  const inputs = experimentalInputs ?? createExperimentalInputs(nodeConfigs, seed, { heterogeneity, freeRiderCount });
  if (!experimentalInputs) {
    inputs.churnSchedule = createChurnSchedule(inputs.nodeConfigs, seed, timeLimitSeconds, {
      churnEnabled, meanOnlineSeconds, meanOfflineSeconds,
    });
  }
  const network = makeNetwork(inputs.nodeConfigs, fileSizeMB);
  network.churnSchedule = inputs.churnSchedule;
  const settings = { onStep, alphaS, alphaB, regularSlots, optimisticSlots, stepSeconds, selectionSteps, contributionSteps };
  const results = strategies.map((strategy) => simulateStrategy(strategy, network, numberOfSteps, settings, seed));

  return { results, network, inputs, seed, settings, durationMinutes: timeLimitSeconds / 60 };
};

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
