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
  durationMinutes = 3,
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
      churnEnabled, meanOnlineSeconds, meanOfflineSeconds, stepSeconds,
    });
  }
  const network = makeNetwork(inputs.nodeConfigs, fileSizeMB);
  network.churnSchedule = inputs.churnSchedule;
  const settings = { onStep, alphaS, alphaB, regularSlots, optimisticSlots, stepSeconds, selectionSteps, contributionSteps };
  const results = strategies.map((strategy) => simulateStrategy(strategy, network, numberOfSteps, settings, seed));

  return { results, network, inputs, seed, settings, durationMinutes: timeLimitSeconds / 60 };
};

export const runSweeps = (config, {
  seed = config.seed ?? 42,
  alphas = [0, 0.25, 0.5, 0.75, 1],
} = {}) => {
  const reference = runExperiment({ ...config, seed, strategies: ['prop', 'unchoke'] });
  const comparisons = reference.results.map((result) => ({ family: 'reference', result }));
  for (const alphaS of alphas) {
    for (const alphaB of alphas) {
      let family = 'mixed';
      let alpha = null;
      if (alphaS === alphaB) {
        family = alphaS === 0 ? 'shared' : 'combined';
        alpha = alphaS;
      } else if (alphaB === 0) {
        family = 'selection-only';
        alpha = alphaS;
      } else if (alphaS === 0) {
        family = 'allocation-only';
        alpha = alphaB;
      }
      const experiment = runExperiment({
        ...config, seed, alphaS, alphaB, strategies: ['hybrid'],
        experimentalInputs: reference.inputs,
      });
      comparisons.push({ family, alpha, alphaS, alphaB, result: experiment.results[0] });
    }
  }
  return { schemaVersion: 1, config, seeds: [seed], alphas,
    repetitions: [{ seed, inputs: reference.inputs, comparisons }] };
};

export const exportExperiment = (experiment) => JSON.stringify(experiment, null, 2);
