import test from "node:test";
import assert from "node:assert/strict";
import { runExperiment, runSweeps } from "../src/simulator.js";
import {
  adaptExperiment,
  adaptSweep,
  bestHybrid,
  buildHeatmap,
  sweepComparison,
} from "../src/results/resultAdapters.js";
import { areaAt, simulationTimeAt } from "../src/results/raceData.js";
import { experimentTraces } from "../src/results/experimentPlotData.js";
import {
  isValidExperiment,
  isValidSweep,
} from "../src/results/resultValidation.js";

const config = {
  peerCount: 3,
  nodeConfigs: [
    { role: "seed" },
    ...Array.from({ length: 3 }, () => ({ role: "peer" })),
  ],
  fileSizeMB: 0.1,
  heterogeneity: 0,
  freeRiderRatio: 0,
  freeRiderCount: 0,
  churnEnabled: false,
  meanOnlineSeconds: 300,
  meanOfflineSeconds: 30,
  alphaS: 0.5,
  alphaB: 0.5,
  seed: 42,
  timeLimitSeconds: 1,
};
const experiment = { ...runExperiment(config), config, schemaVersion: 1 };
const sweep = runSweeps(config);

test("experiment adapters preserve seconds and extend terminal values to deadline", () => {
  assert.equal(isValidExperiment(experiment), true);
  const { rows } = adaptExperiment(experiment);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.series.timesSeconds.at(-1), 180);
    assert.equal(
      row.series.downloadedPercent.at(-1),
      row.meanDownloadedPercent,
    );
    assert.equal(row.series.sampledCompleted[6], row.completed);
    assert.ok(row.finishedTimesSeconds.every(Number.isFinite));
    assert.equal(
      row.finishedTimesSeconds.length + row.unfinishedCount,
      row.peerCount,
    );
  }
  const traces = experimentTraces(rows);
  assert.equal(traces.area.length, 3);
  assert.ok(traces.area.every((trace) => trace.fill === "tozeroy"));
  assert.ok(traces.area.every((trace) => trace.y.every(Number.isInteger)));
  assert.equal(
    traces.boxes.length,
    rows.filter((row) => row.finishedTimesSeconds.length > 0).length,
  );
});

test("sweep maps every configuration and references, with raw missing times", () => {
  assert.equal(isValidSweep(sweep), true);
  const { rows } = adaptSweep(sweep);
  assert.equal(rows.length, 27);
  const matrix = buildHeatmap(rows, "completion");
  assert.equal(matrix.length, 5);
  assert.equal(matrix.flat().length, 25);
  assert.equal(matrix[3][2].alphaS, 0.5);
  assert.equal(matrix[3][2].alphaB, 0.75);
  assert.equal(matrix[3][2].value, matrix[3][2].row.completionPercent);
  const mean = buildHeatmap(rows, "meanTime");
  assert.ok(
    mean
      .flat()
      .every((cell) => cell.value === cell.row.meanAllPeersFinishSeconds),
  );
  assert.equal(rows.filter((row) => row.strategy !== "hybrid").length, 2);
  const best = bestHybrid(rows);
  assert.equal(sweepComparison(rows, null)[0].id, best.id);
  assert.equal(sweepComparison(rows, best.id).length, 3);
  const other = rows.find(
    (row) => row.strategy === "hybrid" && row.id !== best.id,
  );
  assert.equal(sweepComparison(rows, other.id).length, 3);
  assert.equal(sweepComparison(rows, other.id)[0].id, other.id);
  assert.ok(sweepComparison(rows, other.id).every((row) => row.id !== best.id));
});

test("best hybrid ranking follows completion, all-peer mean, then parameters", () => {
  const rows = [
    {
      strategy: "hybrid",
      completionPercent: 90,
      meanAllPeersFinishSeconds: null,
      alphaS: 0,
      alphaB: 0.5,
    },
    {
      strategy: "hybrid",
      completionPercent: 100,
      meanAllPeersFinishSeconds: 80,
      alphaS: 0.5,
      alphaB: 0.5,
    },
    {
      strategy: "hybrid",
      completionPercent: 100,
      meanAllPeersFinishSeconds: 70,
      alphaS: 0.75,
      alphaB: 0,
    },
    {
      strategy: "hybrid",
      completionPercent: 100,
      meanAllPeersFinishSeconds: 70,
      alphaS: 0.25,
      alphaB: 1,
    },
  ];
  assert.equal(bestHybrid(rows), rows[3]);
});

test("race area keeps integer completion counts through 180 seconds", () => {
  const row = adaptExperiment(experiment).rows[0];
  assert.equal(areaAt(row, 180).x.at(-1), 180);
  assert.equal(areaAt(row, 180).y.at(-1), row.completed);
  assert.ok(areaAt(row, 90).y.every(Number.isInteger));
  assert.equal(simulationTimeAt(0), 0);
  assert.equal(simulationTimeAt(2500), 90);
  assert.equal(simulationTimeAt(5000), 180);
  assert.equal(simulationTimeAt(6000), 180);
});

test("unfinished peers are excluded from boxes and mean time remains unavailable", () => {
  const incompleteConfig = { ...config, fileSizeMB: 100 };
  const incompleteExperiment = {
    ...runExperiment(incompleteConfig),
    config: incompleteConfig,
    schemaVersion: 1,
  };
  const rows = adaptExperiment(incompleteExperiment).rows;
  assert.ok(rows.every((row) => row.unfinishedCount === 3));
  assert.ok(rows.every((row) => row.meanAllPeersFinishSeconds === null));
  assert.equal(experimentTraces(rows).boxes.length, 0);
  const incompleteSweep = adaptSweep(runSweeps(incompleteConfig)).rows;
  assert.ok(
    buildHeatmap(incompleteSweep, "meanTime")
      .flat()
      .every((cell) => cell.value === null),
  );
  assert.ok(
    sweepComparison(incompleteSweep, null).every(
      (row) => row.meanAllPeersFinishSeconds === null,
    ),
  );
});

test("malformed imports are rejected", () => {
  assert.equal(
    isValidExperiment({
      ...experiment,
      results: experiment.results.slice(0, 2),
    }),
    false,
  );
  assert.equal(
    isValidExperiment({
      ...experiment,
      results: experiment.results.map((result, index) =>
        index ? result : { ...result, completionTimesSeconds: [] },
      ),
    }),
    false,
  );
  assert.equal(
    isValidSweep({
      ...sweep,
      repetitions: [
        {
          ...sweep.repetitions[0],
          comparisons: sweep.repetitions[0].comparisons.slice(1),
        },
      ],
    }),
    false,
  );
  assert.equal(
    isValidSweep({
      ...sweep,
      repetitions: [
        {
          ...sweep.repetitions[0],
          comparisons: [
            ...sweep.repetitions[0].comparisons.slice(0, 26),
            sweep.repetitions[0].comparisons[0],
          ],
        },
      ],
    }),
    false,
  );
});
