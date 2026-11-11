import { BASE_UPLOAD_MBPS, BASE_DOWNLOAD_MBPS, PIECE_SIZE_MB } from './constants.js';
import { createRandomStreams } from './random.js';

export const createChurnSchedule = (nodeConfigs, seed, timeLimitSeconds, {
  churnEnabled = false, meanOnlineSeconds = 300, meanOfflineSeconds = 30,
} = {}) => {
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
  const streams = createRandomStreams(seed);
  const random = streams.bandwidth;
  const peers = nodeConfigs.flatMap((node, id) => node.role === 'seed' ? [] : [id]);
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

export const makeNetwork = (nodeConfigs, fileSizeMB) => {
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

