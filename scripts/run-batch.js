import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import {
  BASE_DOWNLOAD_MBPS, BASE_UPLOAD_MBPS, PIECE_SIZE_MB, runExperiment,
} from '../src/simulator.js';

const study = isMainThread
  ? JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'))
  : workerData.study;
const pieceBytes = PIECE_SIZE_MB * 1e6;
const pieceCount = Math.ceil(study.fixed.fileBytes / pieceBytes);
const FIXED = {
  ...study.fixed,
  // Exact multiples must use the engine's piece-size multiple to avoid rounding
  // the file up to an extra piece when the simulator divides by PIECE_SIZE_MB.
  fileSizeMB: study.fixed.fileBytes % pieceBytes === 0 ? pieceCount * PIECE_SIZE_MB : study.fixed.fileBytes / 1e6,
  pieceBytes,
  pieceCount,
  hybridUploadSlots: 4,
  hybridRegularSlots: '4 * alpha_s',
  deltaMbps: 2,
  seedUploadMbps: BASE_UPLOAD_MBPS,
  baseLeecherUploadMbps: BASE_UPLOAD_MBPS,
  downloadMbps: BASE_DOWNLOAD_MBPS,
  churnModel: 'per-step Bernoulli',
  churnInitialOnlineProbability: 1,
};
const NODE_CONFIGS = [
  ...Array.from({ length: FIXED.initialSeeders }, () => ({ role: 'seed' })),
  ...Array.from({ length: FIXED.initialLeechers }, () => ({ role: 'peer' })),
];
const factors = study.swarmFactors;
const CONDITIONS = [];
for (const heterogeneity of factors.heterogeneity) {
  for (const churn of [null, factors.churn]) {
    for (const freeRiderCount of factors.freeRiderCounts) {
      const freeRiderRatio = freeRiderCount / FIXED.initialLeechers;
      const id = [
        heterogeneity && `h-${heterogeneity}`,
        churn && 'churn-low',
        freeRiderCount && `free-${freeRiderRatio}`,
      ].filter(Boolean).join('+') || 'baseline';
      const label = [
        heterogeneity && `Upload h = ${heterogeneity}`,
        churn && 'Low churn',
        freeRiderCount && `Free riders: ${100 * freeRiderRatio}%`,
      ].filter(Boolean).join(' · ') || 'Baseline';
      CONDITIONS.push({
        id, label, heterogeneity, freeRiderCount,
        meanOnlineSeconds: churn?.meanOnlineSeconds ?? null,
        meanOfflineSeconds: churn?.meanOfflineSeconds ?? null,
      });
    }
  }
}

const HYBRID_SETTINGS = [
  { sweep: 'shared', alpha: 0, alphaS: 0, alphaB: 0 },
  ...study.alphas.filter(alpha => alpha !== 0).flatMap(alpha => [
    { sweep: 'selection-only', alpha, alphaS: alpha, alphaB: 0 },
    { sweep: 'allocation-only', alpha, alphaS: 0, alphaB: alpha },
    { sweep: 'combined', alpha, alphaS: alpha, alphaB: alpha },
  ]),
].map(setting => ({ ...setting, policy: 'hybrid' }));
const RUN_FIELDS = [
  'run_id', 'condition', 'condition_label', 'seed', 'policy', 'sweep', 'alpha', 'alpha_s', 'alpha_b',
  'regular_slots', 'heterogeneity', 'churn_enabled', 'mean_online_s', 'mean_offline_s',
  'initial_online_probability', 'free_rider_ratio', 'free_rider_count', 'initial_leechers',
  'deadline_s', 'finished_count', 'finished_fraction', 'unfinished_count', 'swarm_finished',
  't_min_s', 't_avg_s', 't_max_s', 'elapsed_s', 'scenario_sha256',
];
const PEER_FIELDS = [
  'run_id', 'peer_id', 'sampled_upload_mbps', 'effective_upload_mbps', 'free_rider',
  'initially_online', 'completion_time_s',
];

async function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, path);
}

function encodeCsv(fields, rows) {
  const escape = value => {
    const cell = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  };
  return [fields.join(','), ...rows.map(row => fields.map(field => escape(row[field])).join(','))].join('\n') + '\n';
}

async function writeResults(out, results) {
  await writeAtomic(join(out, 'runs.csv'), encodeCsv(RUN_FIELDS, results.map(result => result.run)));
  await writeAtomic(join(out, 'peers.csv'), encodeCsv(PEER_FIELDS, results.flatMap(result => result.peers)));
}

function formatResult(scenario, seed, { policy, sweep, alpha, alphaS, alphaB }, result, shared) {
  const runId = `${scenario.id}:${seed}:${policy}:${alphaS}:${alphaB}`;
  const peers = shared.peers.map((peer, index) => ({
    run_id: runId, ...peer, completion_time_s: result.completionTimesSeconds[index],
  }));
  const complete = result.termination === 'complete';
  return {
    run: {
      run_id: runId, condition: scenario.id, condition_label: scenario.label, seed, policy,
      sweep, alpha, alpha_s: alphaS, alpha_b: alphaB,
      regular_slots: FIXED.hybridUploadSlots * alphaS,
      heterogeneity: scenario.heterogeneity, churn_enabled: scenario.meanOnlineSeconds !== null,
      mean_online_s: scenario.meanOnlineSeconds, mean_offline_s: scenario.meanOfflineSeconds,
      initial_online_probability: FIXED.churnInitialOnlineProbability,
      free_rider_ratio: scenario.freeRiderCount / FIXED.initialLeechers, free_rider_count: scenario.freeRiderCount,
      initial_leechers: FIXED.initialLeechers, deadline_s: FIXED.timeLimitSeconds,
      finished_count: result.completed, finished_fraction: result.completionFraction,
      unfinished_count: result.peerCount - result.completed, swarm_finished: complete,
      t_min_s: complete ? result.firstFinishMinutes * 60 : null,
      t_avg_s: result.meanAllPeersFinishSeconds,
      t_max_s: result.swarmFinishSeconds, elapsed_s: result.elapsedSeconds, scenario_sha256: shared.sha256,
    },
    peers,
  };
}

function runSeed({ scenario, seed }) {
  const config = {
    ...FIXED, ...scenario, seed, nodeConfigs: NODE_CONFIGS,
    churnEnabled: scenario.meanOnlineSeconds !== null, strategies: ['hybrid'],
  };
  let inputs;
  const outcomes = HYBRID_SETTINGS.map(({ alphaS, alphaB }) => {
    const experiment = runExperiment({ ...config, alphaS, alphaB, experimentalInputs: inputs });
    inputs ??= experiment.inputs;
    return experiment.results[0];
  });

  const peers = inputs.nodeConfigs.flatMap((node, id) => {
    if (node.role === 'seed') return [];
    const sampled = BASE_UPLOAD_MBPS * node.uploadMultiplier;
    return [{
      peer_id: id, sampled_upload_mbps: sampled,
      effective_upload_mbps: node.isFreeRider ? 0 : sampled,
      free_rider: node.isFreeRider, initially_online: true,
    }];
  });
  const shared = { peers, sha256: createHash('sha256').update(JSON.stringify(inputs)).digest('hex') };
  return HYBRID_SETTINGS.map((setting, index) => formatResult(scenario, seed, setting, outcomes[index], shared));
}

function runWorker(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { ...task, study } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`Worker exited before returning results (code ${code})`)));
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: 'string' },
    workers: { type: 'string', default: String(Math.max(1, Math.floor(availableParallelism() / 2))) },
    help: { type: 'boolean', short: 'h' },
  } });
  const usage = 'Usage: node scripts/run-batch.js --out DIR [--workers N]';
  if (values.help) return console.log(usage);
  const workers = Number(values.workers);
  if (!values.out || !Number.isSafeInteger(workers) || workers < 1) throw new Error(usage);

  const out = values.out;
  const metadataPath = join(out, 'metadata.json');
  const design = {
    schema_version: 1, mode: 'main',
    node_version: process.version,
    fixed: FIXED, conditions: CONDITIONS, seeds: study.mainSeeds, settings: HYBRID_SETTINGS,
    expected_runs: CONDITIONS.length * study.mainSeeds.length * HYBRID_SETTINGS.length,
  };
  await mkdir(out, { recursive: true });
  await writeFile(metadataPath, JSON.stringify({ design, complete: false }, null, 2) + '\n', { flag: 'wx' });

  console.log(`Running ${design.expected_runs} experiments with up to ${workers} workers.`);
  const started = performance.now();
  let finished = 0;

  async function runConditions(conditions) {
    const tasks = conditions.flatMap(scenario => study.mainSeeds.map(seed => ({ scenario, seed })));
    const results = new Array(tasks.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const index = cursor++;
        const task = tasks[index];
        const key = `${task.scenario.id}-${task.seed}`;
        const rows = await runWorker(task);
        results[index] = rows;
        finished += rows.length;
        console.log(`${finished}/${design.expected_runs} runs: ${key}`);
      }
    }));
    return results.flat();
  }

  const baseline = await runConditions(CONDITIONS.slice(0, 1));
  const results = [...baseline, ...await runConditions(CONDITIONS.slice(1))];
  await writeResults(out, results);
  await writeAtomic(metadataPath, JSON.stringify({
    design, complete: true, workers,
    wall_seconds: (performance.now() - started) / 1000,
    run_count: results.length, peer_count: results.length * FIXED.initialLeechers,
  }, null, 2) + '\n');
  console.log(`Saved ${results.length} runs to ${out}`);
}

if (isMainThread) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  parentPort.postMessage(runSeed(workerData));
}
