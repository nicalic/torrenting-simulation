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
const SHORTCUTS_PER_NODE = 1.2;
const SHORTCUT_CHANCE = 0.13;

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

const makeNetwork = (nodeConfigs, averageNeighbours, fileSizeMB, seed) => {
  const nodeCount = nodeConfigs.length;
  const random = createRandomGenerator(seed);
  const links = [];
  for (let node = 0; node < nodeCount; node += 1) {
    links.push([]);
  }

  const maxDegree = Math.min(nodeCount - 1, Math.max(2, averageNeighbours));
  const ringDistance = Math.ceil(maxDegree / 2);
  for (let node = 0; node < nodeCount; node += 1) {
    for (let distance = 1; distance <= ringDistance; distance += 1) {
      const neighbour = (node + distance) % nodeCount;
      if (!links[node].includes(neighbour)) links[node].push(neighbour);
      if (!links[neighbour].includes(node)) links[neighbour].push(node);
    }
  }

  const shortcutAttempts = Math.floor(nodeCount * SHORTCUTS_PER_NODE);
  for (let attempt = 0; attempt < shortcutAttempts; attempt += 1) {
    if (random() > SHORTCUT_CHANCE) continue;

    const source = Math.floor(random() * nodeCount);
    const options = [];
    for (let node = 0; node < nodeCount; node += 1) {
      if (node !== source && !links[source].includes(node)) {
        options.push(node);
      }
    }
    if (options.length === 0) continue;

    const choice = Math.floor(random() * options.length);
    const target = options[choice];
    links[source].push(target);
    links[target].push(source);
  }

  const uploadMbps = [];
  const downloadCapMbps = [];
  const seedIds = [];
  const peerIds = [];
  const freeRiderIds = [];

  for (let node = 0; node < nodeCount; node += 1) {
    const config = nodeConfigs[node];
    uploadMbps.push(BASE_UPLOAD_MBPS * config.uploadMultiplier);
    downloadCapMbps.push(BASE_DOWNLOAD_MBPS * config.downloadMultiplier);

    if (config.role === 'seed') {
      seedIds.push(node);
    } else {
      peerIds.push(node);
      if (config.uploadMultiplier === 0) freeRiderIds.push(node);
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

const simulateStrategy = (strategy, network, numberOfSteps, settings, seed) => {
  const nodeCount = network.uploadMbps.length;
  const peerCount = network.peerIds.length;
  const random = createRandomGenerator(seed);
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

  const finishTimes = Array(nodeCount).fill(null);
  let previousTransfers = [];
  for (let node = 0; node < nodeCount; node += 1) {
    previousTransfers.push(Array(nodeCount).fill(0));
  }

  const times = [0];
  const averageCompletion = [0];
  const completedPeers = [0];

  for (let step = 1; step <= numberOfSteps; step += 1) {
    const proposals = [];

    for (let sender = 0; sender < nodeCount; sender += 1) {
      const interestedNeighbours = [];

      for (const receiver of network.links[sender]) {
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

    for (const transfer of proposals) {
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
  averageNeighbours,
  durationMinutes,
  fileSizeMB,
  regularSlots,
  optimisticSlots,
  seed,
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
  const network = makeNetwork(nodeConfigs, averageNeighbours, fileSizeMB, seed);
  const settings = { regularSlots, optimisticSlots, stepSeconds, selectionSteps, contributionSteps };
  const results = [
    simulateStrategy('prop', network, numberOfSteps, settings, seed),
    simulateStrategy('unchoke', network, numberOfSteps, settings, seed),
  ];

  return { results, network, seed, settings, durationMinutes: timeLimitSeconds / 60 };
};
