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
  durationMinutes,
  fileSizeMB,
  regularSlots = 3,
  optimisticSlots = 1,
  alphaS = 0.5,
  alphaB = 0.5,
  seed = 42,
  churnEnabled = false,
  meanOnlineSeconds = 300,
  meanOfflineSeconds = 30,
  heterogeneity = 0,
  freeRiderCount = 0,
  stepSeconds = 0.1,
  selectionIntervalSeconds = 10,
  contributionWindowSeconds = 20,
  timeLimitSeconds = durationMinutes === undefined ? 1800 : durationMinutes * 60,
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
