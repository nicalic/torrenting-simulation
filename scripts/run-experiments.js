import { readFile, writeFile } from "node:fs/promises";
import { runSweeps, exportExperiment } from "../src/simulator.js";

const [configPath, outputPath] = process.argv.slice(2);
const { config, seed, alphas } = JSON.parse(await readFile(configPath, "utf8"));
await writeFile(
  outputPath,
  exportExperiment(runSweeps(config, { seed, alphas })),
);
console.log(
  "Saved experiment configurations, shared inputs, and results to",
  outputPath,
);
