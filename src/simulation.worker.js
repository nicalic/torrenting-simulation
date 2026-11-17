import { runExperiment, runSweeps } from "./simulator.js";

self.onmessage = ({ data: { config, allReciprocityLevels } }) => {
  const result = allReciprocityLevels
    ? runSweeps(config, { seed: config.seed })
    : { ...runExperiment(config), config, schemaVersion: 1 };
  self.postMessage({ result });
};
