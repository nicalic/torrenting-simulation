import test from "node:test";
import assert from "node:assert/strict";
import {
  runExperiment,
  createExperimentalInputs,
  createChurnSchedule,
  createRandomStreams,
  selectReceivers,
  allocateBandwidth,
  limitDownloads,
} from "../src/simulator.js";
import { runSweeps, exportExperiment } from "../src/simulator.js";

const config = {
  nodeConfigs: [
    { role: "seed" },
    ...Array.from({ length: 5 }, () => ({ role: "peer" })),
  ],
  seed: 42,
  fileSizeMB: 2,
  timeLimitSeconds: 30,
};
test("shared inputs are repeatable, exact and independent", () => {
  const a = createExperimentalInputs(config.nodeConfigs, 42, {
    heterogeneity: 0.8,
    freeRiderCount: 2,
  });
  const b = createExperimentalInputs(config.nodeConfigs, 42, {
    heterogeneity: 0.8,
    freeRiderCount: 4,
  });
  assert.deepEqual(
    a.nodeConfigs.map((n) => n.uploadMultiplier),
    b.nodeConfigs.map((n) => n.uploadMultiplier),
  );
  assert.equal(a.nodeConfigs.filter((n) => n.isFreeRider).length, 2);
  assert.equal(a.nodeConfigs[0].uploadMultiplier, 1);
  assert.ok(
    a.nodeConfigs.every(
      (n) =>
        n.downloadMultiplier === 1 &&
        n.uploadMultiplier >= 0.2 &&
        n.uploadMultiplier <= 1.8,
    ),
  );
  const streams = createRandomStreams(42);
  streams.policy();
  streams.policy();
  assert.equal(streams.churn(), createRandomStreams(42).churn());
  assert.deepEqual(runExperiment(config), runExperiment(config));
});

test("proportional download limiting preserves ratios and capacity", () => {
  const result = limitDownloads(
    [
      { receiver: 0, budgetMB: 20 },
      { receiver: 0, budgetMB: 10 },
      { receiver: 1, budgetMB: 5 },
    ],
    [15, 10],
  );
  assert.deepEqual(
    result.map((r) => r.budgetMB),
    [10, 5, 5],
  );
});

test("hybrid endpoints and reference definitions", () => {
  const candidates = Array.from({ length: 8 }, (_, id) => ({
    id,
    receivedLastStep: id,
  }));
  const settings = { regularSlots: 3, optimisticSlots: 1, alphaS: 1 };
  const selected = selectReceivers("hybrid", candidates, settings, () => 0.5);
  assert.deepEqual(
    selected.map((n) => n.id),
    [7, 6, 5, 4],
  );
  const equal = allocateBandwidth("hybrid", selected, { alphaB: 0 });
  assert.ok(equal.every((n) => n.weight === 0.25));
  const proportional = allocateBandwidth("hybrid", selected, { alphaB: 1 });
  assert.ok(
    Math.abs(proportional.reduce((sum, n) => sum + n.weight, 0) - 1) < 1e-12,
  );
  assert.ok(
    Math.abs(proportional[0].weight / proportional[3].weight - 9 / 6) < 1e-12,
  );
  assert.equal(
    selectReceivers("prop", candidates, settings, () => 0).length,
    8,
  );
  assert.equal(
    allocateBandwidth("prop", [
      { receivedLastStep: 0 },
      { receivedLastStep: 2 },
    ])[0].weight,
    0,
  );
});

test("capacity, piece accounting, reservations, activity and free-rider invariants", () => {
  let steps = 0;
  const inputs = createExperimentalInputs(config.nodeConfigs, 42, {
    heterogeneity: 1,
    freeRiderCount: 1,
  });
  inputs.churnSchedule = createChurnSchedule(config.nodeConfigs, 42, 30, {
    churnEnabled: true,
    meanOnlineSeconds: 0.5,
    meanOfflineSeconds: 0.5,
  });
  assert.deepEqual(inputs.churnSchedule[0], []);
  const upload = inputs.nodeConfigs.map((n) =>
    n.isFreeRider ? 0 : n.uploadMultiplier * 20,
  );
  runExperiment({
    ...config,
    experimentalInputs: inputs,
    onStep: (state) => {
      steps++;
      state.transfers.forEach((row, sender) => {
        assert.ok(
          row.reduce((a, b) => a + b, 0) <= (upload[sender] * 0.1) / 8 + 1e-10,
        );
        row.forEach((mb, receiver) => {
          if (!state.online[sender] || !state.online[receiver])
            assert.equal(mb, 0);
        });
      });
      for (let receiver = 0; receiver < config.nodeConfigs.length; receiver++) {
        assert.ok(
          state.transfers.reduce((sum, row) => sum + row[receiver], 0) <=
            (100 * 0.1) / 8 + 1e-10,
        );
        state.piecesByPeer[receiver].forEach((mb, piece) =>
          assert.ok(mb >= 0 && mb <= state.pieceSizesMB[piece]),
        );
        const reservations = state.reservations[receiver];
        assert.equal(
          new Set(reservations.map(([piece]) => piece)).size,
          reservations.length,
        );
      }
    },
  });
  assert.ok(steps > 0);
});

test("slot selections only refill at rounds and contribution scores stay frozen between rounds", () => {
  let previous;
  runExperiment({
    ...config,
    strategies: ["hybrid"],
    onStep: (state) => {
      if (previous && (state.step - 1) % 100 !== 0) {
        state.selections.forEach((ids, sender) =>
          assert.ok(
            ids.every((id) => previous.selections[sender].includes(id)),
          ),
        );
        assert.deepEqual(state.contributionRates, previous.contributionRates);
      }
      previous = state;
    },
  });
});

test("completion and deadline metrics distinguish unfinished peers", () => {
  const result = runExperiment({
    ...config,
    nodeConfigs: [{ role: "seed" }, { role: "peer" }],
    fileSizeMB: 0.1,
  });
  for (const r of result.results) {
    assert.equal(r.elapsedSeconds, 0.1);
    assert.equal(r.termination, "complete");
    assert.deepEqual(r.downloadedMB, [0.1]);
    assert.equal(r.completionFraction, 1);
    assert.equal(r.meanAllPeersFinishSeconds, r.swarmFinishSeconds);
  }
  const unfinished = runExperiment({
    ...config,
    fileSizeMB: 100,
    timeLimitSeconds: 0.1,
  });
  for (const r of unfinished.results) {
    assert.equal(r.termination, "deadline");
    assert.equal(r.swarmFinishSeconds, null);
    assert.equal(r.meanAllPeersFinishSeconds, null);
    assert.ok(r.completionTimesSeconds.every((t) => t === null));
  }
});

test("sweeps reuse inputs and can be exported and replayed", () => {
  const sweep = runSweeps(
    { ...config, fileSizeMB: 0.1, timeLimitSeconds: 1 },
    { seed: 1, alphas: [0, 1] },
  );
  assert.deepEqual(sweep.seeds, [1]);
  assert.equal(sweep.repetitions.length, 1);
  assert.equal(sweep.repetitions[0].comparisons.length, 6);
  assert.deepEqual(JSON.parse(exportExperiment(sweep)), sweep);
  const rep = sweep.repetitions[0];
  const replay = runExperiment({
    ...sweep.config,
    seed: rep.seed,
    experimentalInputs: rep.inputs,
    strategies: ["prop"],
  });
  assert.deepEqual(replay.results[0], rep.comparisons[0].result);
});

test("single-transfer completion converges at smaller time steps", () => {
  const finish = [0.1, 0.05, 0.025].map(
    (stepSeconds) =>
      runExperiment({
        ...config,
        nodeConfigs: [{ role: "seed" }, { role: "peer" }],
        fileSizeMB: 2.1,
        stepSeconds,
      }).results[0].swarmFinishSeconds,
  );
  // Analytic lower bound is 2.1 MB * 8 / 20 Mbps = .84 seconds.
  finish.forEach((seconds, i) =>
    assert.ok(
      seconds >= 0.84 && seconds <= 0.84 + [0.1, 0.05, 0.025][i] + 1e-10,
    ),
  );
});

test("rolling rates count actual useful bytes and expire old steps", () => {
  const history = [];
  runExperiment({
    ...config,
    strategies: ["prop"],
    fileSizeMB: 100,
    timeLimitSeconds: 3,
    contributionWindowSeconds: 1,
    selectionIntervalSeconds: 0.5,
    onStep: ({ step, transfers, contributionRates }) => {
      if ((step - 1) % 5 === 0) {
        for (let sender = 0; sender < 6; sender++)
          for (let receiver = 0; receiver < 6; receiver++) {
            const expected =
              history
                .slice(-10)
                .reduce((sum, matrix) => sum + matrix[sender][receiver], 0) * 8;
            assert.ok(
              Math.abs(expected - contributionRates[sender][receiver]) < 1e-9,
            );
          }
      }
      history.push(transfers);
    },
  });
});

test("offline interruption retains partial data and reconnect resumes it", () => {
  const nodes = [{ role: "seed" }, { role: "peer" }];
  const inputs = createExperimentalInputs(nodes, 42);
  inputs.churnSchedule = [
    [],
    [
      { time: 0.1, online: false },
      { time: 0.3, online: true },
    ],
  ];
  const snapshots = [];
  runExperiment({
    ...config,
    nodeConfigs: nodes,
    fileSizeMB: 1,
    experimentalInputs: inputs,
    strategies: ["prop"],
    onStep: ({ piecesByPeer, reservations }) => {
      snapshots.push({
        amount: piecesByPeer[1].reduce((a, b) => a + b, 0),
        reservations: reservations[1],
      });
    },
  });
  assert.equal(snapshots[0].amount, 0.25);
  assert.equal(snapshots[1].amount, snapshots[0].amount);
  assert.equal(snapshots[2].amount, snapshots[0].amount);
  assert.deepEqual(snapshots[1].reservations, []);
  assert.ok(snapshots[3].amount > snapshots[2].amount);
});

test("sweeps execute all hybrid settings once with one seed and keep references", () => {
  const starts = [];
  const sweep = runSweeps({
    ...config,
    fileSizeMB: 0.1,
    timeLimitSeconds: 1,
    onStep: ({ step, strategy }) => {
      if (step === 1) starts.push(strategy);
    },
  });
  assert.deepEqual(sweep.seeds, [42]);
  assert.equal(sweep.repetitions.length, 1);
  assert.equal(starts.length, 27);
  assert.equal(starts.filter((strategy) => strategy === "hybrid").length, 25);
  assert.deepEqual(starts.slice(0, 2), ["prop", "unchoke"]);
  const comparisons = sweep.repetitions[0].comparisons;
  assert.equal(comparisons.length, 27);
  assert.equal(
    new Set(
      comparisons.slice(2).map(({ alphaS, alphaB }) => `${alphaS}:${alphaB}`),
    ).size,
    25,
  );
  assert.equal(
    comparisons.filter((row) => row.family === "reference").length,
    2,
  );
  assert.equal(comparisons.filter((row) => row.family === "shared").length, 1);
  assert.equal(comparisons.filter((row) => row.family === "mixed").length, 12);
});
