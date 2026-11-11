import { BITS_PER_BYTE } from './constants.js';
import { createRandomStreams } from './random.js';
import { createUploadProposals } from './policies.js';
import { transferPieces } from './transfers.js';
import { summarizeRun } from './measurements.js';

export const simulateStrategy = (strategy, network, numberOfSteps, settings, seed) => {
  const nodeCount = network.uploadMbps.length;
  const peerCount = network.peerIds.length;
  const random = createRandomStreams(seed).policy;
  const stepSeconds = settings.stepSeconds;

  const pieceSizesMB = [];
  for (let piece = 0; piece < network.pieceCount; piece += 1) {
    const remainingFileMB = network.fileSizeMB - piece * network.pieceSizeMB;
    pieceSizesMB.push(Math.min(network.pieceSizeMB, remainingFileMB));
  }

  let piecesByPeer = [];
  for (let node = 0; node < nodeCount; node += 1) {
    piecesByPeer.push(Array(network.pieceCount).fill(0));
  }
  for (const seedId of network.seedIds) {
    for (let piece = 0; piece < network.pieceCount; piece += 1) {
      piecesByPeer[seedId][piece] = pieceSizesMB[piece];
    }
  }

  const online = Array(nodeCount).fill(true);
  const churnCursors = Array(nodeCount).fill(0);
  const finishTimes = Array(nodeCount).fill(null);
  const contributionTotals = Array.from({ length: nodeCount }, () => Array(nodeCount).fill(0));
  let contributionRates = contributionTotals.map((row) => row.slice());
  const history = Array(settings.contributionSteps);
  const selections = Array.from({ length: nodeCount }, () => []);
  const ongoing = new Map();
  const reservations = Array.from({ length: nodeCount }, () => new Map());
  const times = [0];
  const averageCompletion = [0];
  const completedPeers = [0];

  for (let step = 1; step <= numberOfSteps; step += 1) {
    for (let node = 0; node < nodeCount; node += 1) {
      const events = network.churnSchedule[node];
      while (events[churnCursors[node]]?.time <= (step - 1) * stepSeconds) {
        online[node] = events[churnCursors[node]++].online;
      }
    }
    // Policy scores use only completed previous steps, never transfers from this step.
    if ((step - 1) % settings.selectionSteps === 0) {
      contributionRates = contributionTotals.map((row) =>
        row.map((mb) => mb * BITS_PER_BYTE / (settings.contributionSteps * stepSeconds)));
    }
    const proposals = createUploadProposals({
      strategy, network, settings, step, online, piecesByPeer, pieceSizesMB,
      contributionRates, finishTimes, selections, random,
    });
    const { nextPieces, transfers } = transferPieces({
      proposals, network, stepSeconds, piecesByPeer, pieceSizesMB, ongoing, reservations, random,
    });

    piecesByPeer = nextPieces;
    settings.onStep?.({
      strategy, step, online: online.slice(), transfers,
      piecesByPeer, pieceSizesMB,
      reservations: reservations.map((entries) => Array.from(entries)),
      selections: selections.map((ids) => ids.slice()),
      contributionRates,
    });

    for (const peerId of network.peerIds) {
      if (finishTimes[peerId] !== null) continue;

      let hasWholeFile = true;
      for (let piece = 0; piece < network.pieceCount; piece += 1) {
        if (piecesByPeer[peerId][piece] < pieceSizesMB[piece]) {
          hasWholeFile = false;
          break;
        }
      }

      if (hasWholeFile) finishTimes[peerId] = (step * stepSeconds) / 60;
    }

    let totalCompletion = 0;
    let completedCount = 0;
    for (const peerId of network.peerIds) {
      let downloadedMB = 0;
      for (let piece = 0; piece < network.pieceCount; piece += 1) {
        downloadedMB += piecesByPeer[peerId][piece];
      }
      totalCompletion += Math.min(1, downloadedMB / network.fileSizeMB);
      if (finishTimes[peerId] !== null) completedCount += 1;
    }

    times.push((step * stepSeconds) / 60);
    averageCompletion.push(
      (totalCompletion / peerCount) * 100,
    );
    completedPeers.push(completedCount);
    // Replace the oldest window entry after measuring and transferring this step.
    const historyIndex = (step - 1) % settings.contributionSteps;
    const expired = history[historyIndex];
    for (let sender = 0; sender < nodeCount; sender += 1) {
      for (let receiver = 0; receiver < nodeCount; receiver += 1) {
        contributionTotals[sender][receiver] = Math.max(0,
          contributionTotals[sender][receiver] + transfers[sender][receiver] - (expired?.[sender][receiver] ?? 0));
      }
    }
    history[historyIndex] = transfers;
    if (completedCount === peerCount) break;
  }

  return summarizeRun({
    strategy, network, finishTimes, piecesByPeer, times, averageCompletion, completedPeers,
  });
};
