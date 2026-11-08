export const BASE_UPLOAD_MBPS = 20;
export const BASE_DOWNLOAD_MBPS = 100;
export const PIECE_SIZE_MB = (256 * 1024) / 1_000_000;

export const STRATEGY_COLOURS = {
  prop: '#73b442',
  unchoke: '#438ac2',
};

export const STRATEGY_NAMES = {
  prop: 'Proportional share',
  unchoke: 'Reciprocity based on unchoking',
};

const BITS_PER_BYTE = 8;

// mulberry32 seeded rng from https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript
export const createRandomGenerator = (seed) => {
  let state = Number(seed) >>> 0;

  return () => {
    let value = state += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

// Named streams keep environmental draws independent of policy decisions.
export const createRandomStreams = (seed) => Object.fromEntries(
  ['bandwidth', 'freeRiders', 'churn', 'policy'].map((name, index) =>
    [name, createRandomGenerator((Number(seed) ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0)]),
);

export const createChurnSchedule = (nodeConfigs, seed, timeLimitSeconds, {
  churnEnabled = false, meanOnlineSeconds = 300, meanOfflineSeconds = 30,
} = {}) => {
  if (![meanOnlineSeconds, meanOfflineSeconds].every((x) => Number.isFinite(x) && x > 0)) {
    throw new Error('Churn durations must be positive');
  }
  const random = createRandomStreams(seed).churn;
  return nodeConfigs.map((node) => {
    const events = [];
    if (!churnEnabled || node.role === 'seed') return events;
    let time = 0;
    let online = true;
    while (time < timeLimitSeconds) {
      time += -Math.log(1 - random()) * (online ? meanOnlineSeconds : meanOfflineSeconds);
      online = !online;
      if (time < timeLimitSeconds) events.push({ time, online });
    }
    return events;
  });
};

export const createExperimentalInputs = (nodeConfigs, seed, { heterogeneity = 0, freeRiderCount = 0 } = {}) => {
  if (!Number.isFinite(heterogeneity) || heterogeneity < 0 || heterogeneity > 1) {
    throw new Error('Heterogeneity must be between 0 and 1');
  }
  const streams = createRandomStreams(seed);
  const random = streams.bandwidth;
  const peers = nodeConfigs.flatMap((node, id) => node.role === 'seed' ? [] : [id]);
  if (!Number.isInteger(freeRiderCount) || freeRiderCount < 0 || freeRiderCount > peers.length) {
    throw new Error('Free-rider count must be an integer between zero and the initial leecher count');
  }
  for (let i = peers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(streams.freeRiders() * (i + 1));
    [peers[i], peers[j]] = [peers[j], peers[i]];
  }
  const freeRiders = new Set(peers.slice(0, freeRiderCount));
  return {
    nodeConfigs: nodeConfigs.map((node, id) => ({
      ...node,
      isFreeRider: freeRiders.has(id),
      uploadMultiplier: node.role === 'seed' ? 1 : 1 - heterogeneity + 2 * heterogeneity * random(),
      downloadMultiplier: 1,
    })),
    seed,
    heterogeneity,
  };
};

const makeNetwork = (nodeConfigs, fileSizeMB) => {
  const nodeCount = nodeConfigs.length;
  const links = Array.from({ length: nodeCount }, (_, node) =>
    Array.from({ length: nodeCount }, (_, other) => other).filter((other) => other !== node),
  );

  const uploadMbps = [];
  const downloadCapMbps = [];
  const seedIds = [];
  const peerIds = [];
  const freeRiderIds = [];

  for (let node = 0; node < nodeCount; node += 1) {
    const config = nodeConfigs[node];
    uploadMbps.push(config.isFreeRider ? 0 : BASE_UPLOAD_MBPS * config.uploadMultiplier);
    downloadCapMbps.push(BASE_DOWNLOAD_MBPS * config.downloadMultiplier);

    if (config.role === 'seed') {
      seedIds.push(node);
    } else {
      peerIds.push(node);
      if (config.isFreeRider) freeRiderIds.push(node);
    }
  }

  const sortedLinks = links.map((neighbours) => neighbours.sort((a, b) => a - b));

  return {
    links: sortedLinks,
    uploadMbps,
    downloadCapMbps,
    seedIds,
    peerIds,
    freeRiderIds,
    fileSizeMB,
    pieceSizeMB: PIECE_SIZE_MB,
    pieceCount: Math.ceil(fileSizeMB / PIECE_SIZE_MB),
  };
};

export const limitDownloads = (proposals, capacitiesMB) => {
  const incoming = capacitiesMB.map(() => 0);
  for (const transfer of proposals) incoming[transfer.receiver] += transfer.budgetMB;
  return proposals.map((transfer) => ({
    ...transfer,
    budgetMB: transfer.budgetMB * Math.min(1, capacitiesMB[transfer.receiver] / (incoming[transfer.receiver] || 1)),
  }));
};

const simulateStrategy = (strategy, network, numberOfSteps, settings, seed) => {
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
  let previousTransfers = [];
  for (let node = 0; node < nodeCount; node += 1) {
    previousTransfers.push(Array(nodeCount).fill(0));
  }

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
    const proposals = [];

    for (let sender = 0; sender < nodeCount; sender += 1) {
      if (!online[sender] || network.uploadMbps[sender] === 0) continue;
      const interestedNeighbours = [];

      for (const receiver of network.links[sender]) {
        if (!online[receiver]) continue;
        let hasNeededPiece = false;
        for (let piece = 0; piece < network.pieceCount; piece += 1) {
          const senderHasPiece = piecesByPeer[sender][piece] === pieceSizesMB[piece];
          const receiverHasPiece = piecesByPeer[receiver][piece] === pieceSizesMB[piece];
          if (senderHasPiece && !receiverHasPiece) {
            hasNeededPiece = true;
            break;
          }
        }

        if (hasNeededPiece) {
          interestedNeighbours.push({
            id: receiver,
            receivedLastStep: previousTransfers[receiver][sender],
          });
        }
      }

      if (interestedNeighbours.length === 0) continue;
      const B_i = network.uploadMbps[sender];

      if (strategy === 'prop') {
        for (const neighbour of interestedNeighbours) {
          neighbour.weight = neighbour.receivedLastStep;
        }
      } else {
        for (const neighbour of interestedNeighbours) {
          neighbour.tieBreak = random();
        }
        interestedNeighbours.sort((left, right) => {
          const contributionDifference =
            right.receivedLastStep - left.receivedLastStep;
          if (contributionDifference !== 0) return contributionDifference;
          return left.tieBreak - right.tieBreak;
        });

        const k_r = Math.min(settings.regularSlots, interestedNeighbours.length);
        const k_o = Math.min(
          settings.optimisticSlots,
          interestedNeighbours.length - k_r,
        );
        const unchokedPeers = [];

        for (let slot = 0; slot < k_r; slot += 1) {
          unchokedPeers.push(interestedNeighbours[slot].id);
        }

        const optimisticOptions = interestedNeighbours.slice(k_r);
        for (let index = optimisticOptions.length - 1; index > 0; index -= 1) {
          const otherIndex = Math.floor(random() * (index + 1));
          [optimisticOptions[index], optimisticOptions[otherIndex]] = [
            optimisticOptions[otherIndex],
            optimisticOptions[index],
          ];
        }
        for (let slot = 0; slot < k_o; slot += 1) {
          unchokedPeers.push(optimisticOptions[slot].id);
        }

        for (const neighbour of interestedNeighbours) {
          neighbour.weight = unchokedPeers.includes(neighbour.id) ? 1 : 0;
        }
      }

      let totalWeight = 0;
      for (const neighbour of interestedNeighbours) totalWeight += neighbour.weight;

      if (strategy === 'prop' && totalWeight === 0) {
        for (const neighbour of interestedNeighbours) neighbour.weight = 1;
        totalWeight = interestedNeighbours.length;
      }

      for (const neighbour of interestedNeighbours) {
        if (neighbour.weight === 0) continue;
        const uploadRate = (B_i * neighbour.weight) / totalWeight;
        proposals.push({
          sender,
          receiver: neighbour.id,
          budgetMB: (uploadRate * stepSeconds) / BITS_PER_BYTE,
        });
      }
    }

    for (let index = proposals.length - 1; index > 0; index -= 1) {
      const otherIndex = Math.floor(random() * (index + 1));
      [proposals[index], proposals[otherIndex]] = [
        proposals[otherIndex],
        proposals[index],
      ];
    }

    const downloadLeft = [];
    for (let node = 0; node < nodeCount; node += 1) {
      downloadLeft.push(
        (network.downloadCapMbps[node] * stepSeconds) / BITS_PER_BYTE,
      );
    }

    const nextPieces = piecesByPeer.map((pieces) => pieces.slice());
    const transfers = [];
    for (let node = 0; node < nodeCount; node += 1) {
      transfers.push(Array(nodeCount).fill(0));
    }
    const pieceCounts = Array(network.pieceCount).fill(0);

    for (const pieces of piecesByPeer) {
      for (let piece = 0; piece < network.pieceCount; piece += 1) {
        if (pieces[piece] === pieceSizesMB[piece]) {
          pieceCounts[piece] += 1;
        }
      }
    }

    for (const transfer of limitDownloads(proposals, downloadLeft)) {
      let budgetMB = Math.min(
        transfer.budgetMB,
        downloadLeft[transfer.receiver],
      );

      while (budgetMB > 0) {
        let rarestFrequency = Infinity;
        const rarestPieces = [];

        for (let piece = 0; piece < network.pieceCount; piece += 1) {
          const senderHasPiece =
            piecesByPeer[transfer.sender][piece] === pieceSizesMB[piece];
          const receiverHasPiece =
            nextPieces[transfer.receiver][piece] === pieceSizesMB[piece];
          if (!senderHasPiece || receiverHasPiece) continue;

          if (pieceCounts[piece] < rarestFrequency) {
            rarestFrequency = pieceCounts[piece];
            rarestPieces.length = 0;
            rarestPieces.push(piece);
          } else if (pieceCounts[piece] === rarestFrequency) {
            rarestPieces.push(piece);
          }
        }

        if (rarestPieces.length === 0) break;
        const choice = Math.floor(random() * rarestPieces.length);
        const selectedPiece = rarestPieces[choice];
        const missingMB =
          pieceSizesMB[selectedPiece] -
          nextPieces[transfer.receiver][selectedPiece];
        const sentMB = Math.min(
          budgetMB,
          downloadLeft[transfer.receiver],
          missingMB,
        );

        if (sentMB <= 0) break;

        if (sentMB === missingMB) {
          nextPieces[transfer.receiver][selectedPiece] =
            pieceSizesMB[selectedPiece];
        } else {
          nextPieces[transfer.receiver][selectedPiece] += sentMB;
        }

        budgetMB -= sentMB;
        downloadLeft[transfer.receiver] -= sentMB;
        transfers[transfer.sender][transfer.receiver] +=
          (sentMB * BITS_PER_BYTE) / stepSeconds;
      }
    }

    piecesByPeer = nextPieces;

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
      totalCompletion += downloadedMB / network.fileSizeMB;
      if (finishTimes[peerId] !== null) completedCount += 1;
    }

    times.push((step * stepSeconds) / 60);
    averageCompletion.push(
      peerCount === 0 ? 100 : (totalCompletion / peerCount) * 100,
    );
    completedPeers.push(completedCount);
    previousTransfers = transfers;
  }

  const finishedTimes = [];
  let firstFinishMinutes = null;
  let lastFinishMinutes = null;

  for (const peerId of network.peerIds) {
    const finishTime = finishTimes[peerId];
    if (finishTime === null) continue;

    finishedTimes.push(finishTime);

    if (firstFinishMinutes === null || finishTime < firstFinishMinutes) {
      firstFinishMinutes = finishTime;
    }

    if (lastFinishMinutes === null || finishTime > lastFinishMinutes) {
      lastFinishMinutes = finishTime;
    }
  }

  if (finishedTimes.length < peerCount) lastFinishMinutes = null;

  let totalFinishTime = 0;
  for (const finishTime of finishedTimes) totalFinishTime += finishTime;

  return {
    strategy,
    times,
    averageCompletion,
    completedPeers,
    peerCount,
    firstFinishMinutes,
    lastFinishMinutes,
    finalCompletion: averageCompletion[averageCompletion.length - 1],
    completed: completedPeers[completedPeers.length - 1],
    meanFinishMinutes:
      finishedTimes.length === 0 ? null : totalFinishTime / finishedTimes.length,
    finishedTimesCount: finishedTimes.length,
  };
};

export const runExperiment = ({
  nodeConfigs,
  durationMinutes,
  fileSizeMB,
  regularSlots,
  optimisticSlots,
  seed,
  churnEnabled = false,
  meanOnlineSeconds = 300,
  meanOfflineSeconds = 30,
  heterogeneity = 0,
  freeRiderCount = 0,
  stepSeconds = 0.1,
  selectionIntervalSeconds = 10,
  contributionWindowSeconds = 20,
  timeLimitSeconds = durationMinutes === undefined ? 1800 : durationMinutes * 60,
}) => {
  const toSteps = (seconds, name) => {
    const steps = seconds / stepSeconds;
    if (!Number.isFinite(steps) || steps < 1 || Math.abs(steps - Math.round(steps)) > 1e-8) {
      throw new Error(`${name} must be a positive integer multiple of the simulation step`);
    }
    return Math.round(steps);
  };
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) throw new Error('Invalid simulation step');
  const numberOfSteps = toSteps(timeLimitSeconds, 'Time limit');
  const selectionSteps = toSteps(selectionIntervalSeconds, 'Selection interval');
  const contributionSteps = toSteps(contributionWindowSeconds, 'Contribution window');
  const inputs = createExperimentalInputs(nodeConfigs, seed, { heterogeneity, freeRiderCount });
  inputs.churnSchedule = createChurnSchedule(inputs.nodeConfigs, seed, timeLimitSeconds, { churnEnabled, meanOnlineSeconds, meanOfflineSeconds });
  const network = makeNetwork(inputs.nodeConfigs, fileSizeMB);
  network.churnSchedule = inputs.churnSchedule;
  const settings = { regularSlots, optimisticSlots, stepSeconds, selectionSteps, contributionSteps };
  const results = [
    simulateStrategy('prop', network, numberOfSteps, settings, seed),
    simulateStrategy('unchoke', network, numberOfSteps, settings, seed),
  ];

  return { results, network, inputs, seed, settings, durationMinutes: timeLimitSeconds / 60 };
};
