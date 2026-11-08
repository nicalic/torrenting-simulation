import { runExperiment } from './simulator.js';
import { runSweeps } from './experiments.js';

self.onmessage = ({ data: { mode, config } }) => {
  try {
    const result = mode === 'sweep'
      ? runSweeps(config, { seeds: Array.from({ length: config.repetitions }, (_, i) => config.seed + i) })
      : { ...runExperiment(config), config, schemaVersion: 1 };
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
