export const summarizeRun = ({
  strategy, network, finishTimes, piecesByPeer, times, averageCompletion, completedPeers,
}) => {
  const peerCount = network.peerIds.length;
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
    completionTimesSeconds: network.peerIds.map((id) => finishTimes[id] === null ? null : finishTimes[id] * 60),
    completionFraction: finishedTimes.length / peerCount,
    swarmFinishSeconds: lastFinishMinutes === null ? null : lastFinishMinutes * 60,
    meanAllPeersFinishSeconds: finishedTimes.length === peerCount ? totalFinishTime * 60 / peerCount : null,
    elapsedSeconds: times.at(-1) * 60,
    termination: finishedTimes.length === peerCount ? 'complete' : 'deadline',
    downloadedMB: network.peerIds.map((id) => piecesByPeer[id].reduce((sum, mb) => sum + mb, 0)),
  };
};

