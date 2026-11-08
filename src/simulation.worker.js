import { runExperiment } from './simulator.js';
import { runSweeps } from './experiments.js';

self.onmessage = ({ data: { mode, config } }) => {
  const result = mode === 'sweep'
    ? runSweeps(config, { seeds: Array.from({ length: config.repetitions }, (_, i) => config.seed + i) })
    : { ...runExperiment(config), config, schemaVersion: 1 };
  self.postMessage({ result });
};
