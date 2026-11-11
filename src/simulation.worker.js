import { runExperiment } from './simulator.js';

self.onmessage = ({ data: { config } }) => {
  const result = { ...runExperiment(config), config, schemaVersion: 1 };
  self.postMessage({ result });
};
