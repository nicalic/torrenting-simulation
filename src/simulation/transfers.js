import { BITS_PER_BYTE } from './constants.js';

export const limitDownloads = (proposals, capacitiesMB) => {
  const incoming = capacitiesMB.map(() => 0);
  for (const transfer of proposals) incoming[transfer.receiver] += transfer.budgetMB;
  return proposals.map((transfer) => ({
    ...transfer,
    budgetMB: transfer.budgetMB * Math.min(1, capacitiesMB[transfer.receiver] / (incoming[transfer.receiver] || 1)),
  }));
};

// Read sender ownership from the start-of-step snapshot. Apply received bytes to a copy.
// Ongoing reservations survive steps and are released when their connection disappears.
export const transferPieces = ({
  proposals, network, stepSeconds, piecesByPeer, pieceSizesMB, ongoing, reservations, random,
}) => {
  const nodeCount = network.uploadMbps.length;
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

  const limited = limitDownloads(proposals, downloadLeft);
  const active = new Set(limited.filter((t) => t.budgetMB > 0).map((t) => t.sender + ':' + t.receiver));
  for (const [key, transfer] of ongoing) {
    if (!active.has(key)) {
      reservations[transfer.receiver].delete(transfer.piece);
      ongoing.delete(key);
    }
  }
  for (const transfer of limited) {
    const key = transfer.sender + ':' + transfer.receiver;
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
        const owner = reservations[transfer.receiver].get(piece);
        if (!senderHasPiece || receiverHasPiece || (owner !== undefined && owner !== transfer.sender)) continue;

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
      const selectedPiece = ongoing.get(key)?.piece ?? rarestPieces[choice];
      reservations[transfer.receiver].set(selectedPiece, transfer.sender);
      ongoing.set(key, { ...transfer, piece: selectedPiece });
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
        reservations[transfer.receiver].delete(selectedPiece);
        ongoing.delete(key);
      } else {
        nextPieces[transfer.receiver][selectedPiece] += sentMB;
      }

      budgetMB -= sentMB;
      downloadLeft[transfer.receiver] -= sentMB;
      transfers[transfer.sender][transfer.receiver] +=
        sentMB;
    }
  }

  return { nextPieces, transfers };
};
