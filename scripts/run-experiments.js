import { readFile, writeFile } from 'node:fs/promises';
import { runSweeps, exportExperiment } from '../src/experiments.js';

const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath) {
  throw new Error('Usage: node scripts/run-experiments.js config.json results.json');
}
const { config, seeds, alphas } = JSON.parse(await readFile(configPath, 'utf8'));
await writeFile(outputPath, exportExperiment(runSweeps(config, { seeds, alphas })));
console.log('Saved experiment configurations, shared inputs, and results to', outputPath);
