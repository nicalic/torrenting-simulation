import { BITS_PER_BYTE } from './constants.js';

// receivedLastStep is the existing public field name for the rolling contribution rate (Mbps).
export const selectReceivers = (strategy, eligible, settings, random) => {
  if (strategy === 'prop') return eligible;
  const regularSlots = strategy === 'hybrid' ? 4 * settings.alphaS : settings.regularSlots;
  const optimisticSlots = strategy === 'hybrid' ? 4 - regularSlots : settings.optimisticSlots;
  const ranked = eligible.map((node) => ({ ...node, tieBreak: random() }))
    .sort((a, b) => b.receivedLastStep - a.receivedLastStep || a.tieBreak - b.tieBreak);
  const regular = ranked.slice(0, regularSlots);
  const options = ranked.slice(regularSlots);
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return [...regular, ...options.slice(0, optimisticSlots)];
};

export const allocateBandwidth = (strategy, selected, settings = {}) => {
  const total = selected.reduce((sum, node) => sum + node.receivedLastStep, 0);
  return selected.map((node) => {
    let weight = 1;
    if (strategy === 'hybrid') {
      const equalShare = (1 - settings.alphaB) / selected.length;
      const contributionShare = settings.alphaB * (node.receivedLastStep + 2) /
        (total + 2 * selected.length);
      weight = equalShare + contributionShare;
    } else if (strategy === 'prop' && total > 0) {
      weight = node.receivedLastStep;
    }
    return { ...node, weight };
  });
};

// Selections persist between rounds; only eligible retained receivers receive allocations.
export const createUploadProposals = ({
  strategy, network, settings, step, online, piecesByPeer, pieceSizesMB,
  contributionRates, finishTimes, selections, random,
}) => {
  const nodeCount = network.uploadMbps.length;
  const stepSeconds = settings.stepSeconds;
  const proposals = [];

  for (let sender = 0; sender < nodeCount; sender += 1) {
    if (!online[sender] || network.uploadMbps[sender] === 0) {
      selections[sender] = [];
      continue;
    }
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
          receivedLastStep: contributionRates[receiver][sender],
        });
      }
    }

    if (interestedNeighbours.length === 0) {
      selections[sender] = [];
      continue;
    }
    const uploadMbps = network.uploadMbps[sender];

    const isSeeder = network.seedIds.includes(sender) || finishTimes[sender] !== null;
    let selectionStrategy = strategy;
    let policySettings = settings;
    if (isSeeder) {
      // Seeders use optimistic selection for every slot, regardless of contribution.
      const slotCount = strategy === 'hybrid' ? 4 : settings.regularSlots + settings.optimisticSlots;
      policySettings = { ...settings, regularSlots: 0, optimisticSlots: slotCount };
      selectionStrategy = strategy === 'hybrid' ? 'unchoke' : strategy;
    }
    const candidates = isSeeder
      ? interestedNeighbours.map((node) => ({ ...node, receivedLastStep: 0 }))
      : interestedNeighbours;
    if (strategy === 'prop' || (step - 1) % settings.selectionSteps === 0) {
      selections[sender] = selectReceivers(
        selectionStrategy, candidates, policySettings, random,
      ).map((node) => node.id);
    } else {
      selections[sender] = selections[sender].filter((id) => candidates.some((node) => node.id === id));
    }
    const selected = candidates.filter((node) => selections[sender].includes(node.id));
    const weighted = allocateBandwidth(isSeeder ? 'seed' : strategy, selected, settings);
    const totalWeight = weighted.reduce((sum, node) => sum + node.weight, 0);

    for (const neighbour of weighted) {
      if (neighbour.weight === 0) continue;
      const uploadRate = (uploadMbps * neighbour.weight) / totalWeight;
      proposals.push({
        sender,
        receiver: neighbour.id,
        budgetMB: (uploadRate * stepSeconds) / BITS_PER_BYTE,
      });
    }
  }

  return proposals;
};
