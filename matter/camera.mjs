// Camera allocation and WebRTC signaling adapted from linanw's MIT-licensed Mijia plugin.
import { resolve } from 'import-meta-resolve';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Behaviors must share the Homebridge host's Matter runtime and its session/transaction types.
const host = pathToFileURL(createRequire(import.meta.url).resolve('homebridge')).href;
const sdk = path => import(resolve('@matter/main/' + path, host));
const { CameraDevice } = await sdk('devices/camera');
const { CameraAvStreamManagementServer } = await sdk('behaviors/camera-av-stream-management');
const { WebRtcTransportProviderServer } = await sdk('behaviors/web-rtc-transport-provider');
const { WebRtcTransportRequestorClient } = await sdk('behaviors/web-rtc-transport-requestor');
const { WebRtcTransportRequestor } = await sdk('clusters/web-rtc-transport-requestor');
const { CameraAvStreamManagement } = await sdk('clusters/camera-av-stream-management');
const { Status, StatusResponseError, StreamUsage, EndpointNumber } = await sdk('types');
const { assertRemoteActor, NodeSession, Invoke } = await sdk('protocol');

const LIVE = StreamUsage.LiveView;
const reject = (status, message) => { throw new StatusResponseError(message, status); };
const samePeer = (a, b) => a.fabricIndex === b.fabricIndex && a.nodeId === b.nodeId;
const clone = value => structuredClone(value);

function requireOwner(item, peer, kind) {
  if (!item || !samePeer(item.owner, peer)) reject(Status.NotFound, `${kind} not found`);
  return item;
}

/** Runtime resource accounting shared by all fabrics of one camera. Not persisted encoder state. */
let nextSessionId = 1;
class MatterCameraResources {
  constructor(maxStreams = 2) {
    this.maxStreams = maxStreams;
    this.allocated = { video: new Map(), audio: new Map(), snapshot: new Map() };
    this.sessions = new Map();
    this.nextStream = 1;

  }
  reserve(kind, owner, stream) {
    const map = this.allocated[kind];
    if (!map) reject(Status.InvalidCommand, 'Unsupported stream kind');
    if (map.size >= this.maxStreams) reject(Status.ResourceExhausted, 'Encoder capacity is allocated');
    const id = this.nextStream;
    this.nextStream = this.nextStream % 65534 + 1;
    map.set(id, { owner: { ...owner }, stream: { ...clone(stream), [`${kind}StreamId`]: id, referenceCount: 0 } });
    return id;
  }
  own(kind, id, owner) { return requireOwner(this.allocated[kind]?.get(id), owner, 'Stream'); }
  deallocate(kind, id, owner) {
    const entry = this.own(kind, id, owner);
    if (entry.stream.referenceCount) reject(Status.InvalidInState, 'Stream is in use');
    this.allocated[kind].delete(id);
  }
  select(kind, request, owner) {
    const listKey = `${kind}Streams`, legacyKey = `${kind}StreamId`;
    let ids;
    if (request[listKey] !== undefined) ids = request[listKey];
    else if (request[legacyKey] !== undefined) ids = request[legacyKey] === null ? null : [request[legacyKey]];
    else return undefined;
    if (ids === null) {
      const first = [...this.allocated[kind].values()].find(entry => samePeer(entry.owner, owner));
      if (!first) reject(Status.InvalidInState, 'Allocate stream before starting a session');
      return first;
    }
    if (!Array.isArray(ids) || ids.length > 1) reject(Status.ConstraintError, 'One stream is supported');
    return ids.length ? this.own(kind, ids[0], owner) : undefined;
  }
  openSession({ owner, peerEndpointId, video, audio }) {
    if (this.sessions.size >= this.maxStreams) reject(Status.ResourceExhausted, 'Camera is already streaming');
    if (!video && !audio) reject(Status.InvalidCommand, 'An allocated media stream is required');
    for (const [kind, entry] of [['video', video], ['audio', audio]]) {
      if (!entry) continue;
      requireOwner(entry, owner, 'Stream');
      if (this.allocated[kind].get(entry.stream[`${kind}StreamId`]) !== entry) reject(Status.NotFound, 'Stream not found');
    }
    const id = nextSessionId;
    nextSessionId = nextSessionId % 65534 + 1;
    const item = { id, owner: { ...owner }, peerEndpointId, video, audio, state: 'connecting', pendingCandidates: [], ready: false,
      pendingRemoteCandidates: [], mediaCreated: false, mediaId: `${owner.fabricIndex}:${owner.nodeId}:${id}` };
    this.sessions.set(id, item);
    for (const entry of [video, audio]) if (entry) entry.stream.referenceCount++;
    return item;
  }
  session(id, owner) { return requireOwner(this.sessions.get(id), owner, 'Session'); }
  detachSession(item) {
    if (this.sessions.get(item.id) !== item || item.ending) return false;
    item.ending = true;
    clearTimeout(item.timer);
    item.pendingCandidates.length = 0;
    item.pendingRemoteCandidates.length = 0;
    this.sessions.delete(item.id);
    for (const entry of [item.video, item.audio]) if (entry) entry.stream.referenceCount = Math.max(0, entry.stream.referenceCount - 1);
    return true;
  }
  forgetFabric(fabricIndex) {
    const removed = [...this.sessions.values()].filter(item => item.owner.fabricIndex === fabricIndex);
    for (const item of removed) this.detachSession(item);
    for (const map of Object.values(this.allocated)) {
      for (const [id, entry] of map) if (entry.owner.fabricIndex === fabricIndex) map.delete(id);
    }
    return removed;
  }
  clear() {
    const removed = [...this.sessions.values()];
    for (const item of removed) this.detachSession(item);
    for (const map of Object.values(this.allocated)) map.clear();
    return removed;
  }
}

export function normalizeMatterVideoAllocation(request, { width, height, frameRate, bitRate }) {
  if (request.streamUsage !== LIVE) reject(Status.InvalidCommand, 'Only live view is supported');
  if (request.videoCodec !== 0) reject(Status.InvalidCommand, 'Only H264 is supported');
  for (const [min, max] of [[request.minFrameRate, request.maxFrameRate], [request.minBitRate, request.maxBitRate],
    [request.minResolution?.width, request.maxResolution?.width], [request.minResolution?.height, request.maxResolution?.height]]) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || min > max) reject(Status.ConstraintError, 'Invalid allocation range');
  }
  if (request.minResolution.width > width || request.minResolution.height > height || request.minFrameRate > frameRate
    || request.minBitRate > bitRate || request.maxBitRate < 64000) reject(Status.ResourceExhausted, 'Requested stream exceeds capacity');
  if (request.watermarkEnabled || request.osdEnabled) reject(Status.InvalidCommand, 'Overlay is unsupported');
  if (!Number.isInteger(request.keyFrameInterval) || request.keyFrameInterval < 1000 || request.keyFrameInterval > 4000)
    reject(Status.ConstraintError, 'Keyframe interval is outside supported range');
  const actual = { ...clone(request), maxFrameRate: Math.min(frameRate, request.maxFrameRate),
    maxResolution: { width: Math.min(width, request.maxResolution.width) & ~1, height: Math.min(height, request.maxResolution.height) & ~1 },
    minBitRate: Math.max(64000, request.minBitRate), maxBitRate: Math.min(bitRate, request.maxBitRate) };
  if (actual.maxResolution.width < 160 || actual.maxResolution.height < 120
    || actual.maxResolution.width < request.minResolution.width || actual.maxResolution.height < request.minResolution.height)
    reject(Status.ResourceExhausted, 'Requested resolution is unsupported');
  return actual;
}

export function validateMatterTransportRequest(request) {
  if (request.streamUsage !== undefined && request.streamUsage !== LIVE) reject(Status.InvalidCommand, 'Only live view is supported');
  if (request.metadataEnabled) reject(Status.InvalidCommand, 'Metadata is unsupported');
  if (request.iceTransportPolicy && request.iceTransportPolicy !== 'all') reject(Status.InvalidCommand, 'Only LAN ICE transport is supported');
  if (request.iceServers?.length) reject(Status.InvalidCommand, 'External ICE servers are unsupported');
  if (request.webRtcSessionId != null) reject(Status.InvalidInState, 'End the existing session before renegotiating');
  if (!Number.isInteger(request.originatingEndpointId) || request.originatingEndpointId < 0 || request.originatingEndpointId > 65534)
    reject(Status.InvalidCommand, 'Requestor endpoint is required');
}

export function describeMatterSession(item) {
  return { id: item.id, peerNodeId: item.owner.nodeId, peerEndpointId: item.peerEndpointId,
    fabricIndex: item.owner.fabricIndex, streamUsage: LIVE, metadataEnabled: false,
    videoStreamId: item.video?.stream.videoStreamId ?? null, audioStreamId: item.audio?.stream.audioStreamId ?? null,
    ...(item.video ? { videoStreams: [item.video.stream.videoStreamId] } : {}),
    ...(item.audio ? { audioStreams: [item.audio.stream.audioStreamId] } : {}) };
}

/** Keep external encoder accounting atomic with Matter's own cluster-state transaction. */
export function enrollMatterSession({ resources, item, transaction, publish, start, afterRollback,
  schedule = setImmediate }) {
  let launchScheduled = false;
  let rolledBack = false;
  const rollback = () => {
    if (rolledBack) return;
    rolledBack = true;
    resources.detachSession(item);
    if (afterRollback) schedule(afterRollback);
  };
  const committed = () => {
    if (launchScheduled || rolledBack) return;
    launchScheduled = true;
    schedule(() => { if (resources.sessions.get(item.id) === item && !item.ending) start(); });
  };
  try {
    transaction.addParticipants({
      toString: () => `camera-session-create#${item.id}`,
      rollback,
      postCommit: committed,
      conclusion(outcome) { if (outcome === 'committed') committed(); else rollback(); },
    });
    publish();
  } catch (error) {
    rollback();
    // The enclosing transaction also rolls back. Restore its view immediately when synchronous validation failed.
    try { publish(); } catch {}
    throw error;
  }
}

function matterLabel(value) {
  let label = '';
  for (const character of value) {
    if (Buffer.byteLength(label + character) > 32) break;
    label += character;
  }
  return label;
}

export function cameraAccessory(camera, UUID, media) {
  const width = 640, height = 360, fps = 15, bitRate = 700000, maxStreams = 2;
  const audioEnabled = media.config.enableAudio;
  const resources = new MatterCameraResources(maxStreams), { allocated, sessions } = resources;
  const features = ['Video', 'Snapshot', ...(audioEnabled ? ['Audio'] : [])];
  let endpoint, server, closed = false, nextControl = 1;

  function actor(behavior) {
    assertRemoteActor(behavior.context);
    NodeSession.assert(behavior.context.session);
    const address = behavior.context.session.peerAddress;
    return { fabricIndex: address.fabricIndex, nodeId: address.nodeId };
  }
  function live(usage) { if (usage !== LIVE) reject(Status.InvalidCommand, 'Only live view is supported'); }
  function own(map, id, owner) {
    return requireOwner(map.get(id), owner, 'Stream');
  }
  function sessionFor(behavior, id) {
    return resources.session(id, actor(behavior));
  }
  function checkRange(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || min > max) reject(Status.ConstraintError, 'Invalid allocation range');
  }
  function validateResolution(request) {
    checkRange(request.minResolution?.width, request.maxResolution?.width);
    checkRange(request.minResolution?.height, request.maxResolution?.height);
    if (request.minResolution.width > width || request.minResolution.height > height)
      reject(Status.ResourceExhausted, 'Requested resolution exceeds capacity');
  }
  function reserve(kind, owner, stream) {
    return resources.reserve(kind, owner, stream);
  }
  function streamList(kind) { return [...allocated[kind].values()].map(item => clone(item.stream)); }
  function describeSession(item) {
    return describeMatterSession(item);
  }
  async function syncState() {
    if (!endpoint || closed) return;
    await endpoint.set({ cameraAvStreamManagement: { allocatedVideoStreams: streamList('video'),
      ...(audioEnabled ? {allocatedAudioStreams: streamList('audio')} : {}), allocatedSnapshotStreams: streamList('snapshot') },
    webRtcTransportProvider: { currentSessions: [...sessions.values()].map(describeSession) } });
  }
  function updateInBehavior(behavior, kind) {
    behavior.state[`allocated${kind[0].toUpperCase()}${kind.slice(1)}Streams`] = streamList(kind);
  }
  function beforeCommit(behavior, operation, message) {
    // $Changing is synchronous. A phase-one participant can await the hardware and reject the Matter write
    // before the attribute commits; an asynchronous $Changed observer would acknowledge failures as successes.
    const controlId = nextControl++;
    behavior.context.transaction.addParticipants({
      role: Symbol('camera-control'), toString: () => `camera-control#${controlId}`,
      async commit1() {
        try { await operation(); }
        catch { reject(Status.Failure, message); }
      },
    });
  }
  async function invokeRequestor(item, command, fields) {
    if (closed || (command !== 'end' && !sessions.has(item.id))) return;
    const peer = await server.peers.forAddress(item.owner);
    const request = Invoke({ endpoint: EndpointNumber(item.peerEndpointId), cluster: WebRtcTransportRequestor, command, fields });
    for await (const chunk of peer.interaction.invoke(request)) {
      for (const entry of chunk) {
        if (entry.kind === 'cmd-status' && entry.status !== Status.Success) throw new Error('matter_signaling_rejected');
      }
    }
  }
  async function end(item, reason = 2, notify = false, synchronize = true) {
    if (!resources.detachSession(item)) return;
    await media.closeSession(item.mediaId).catch(() => {});
    if (synchronize) await syncState().catch(() => {});
    // Stop encoders and release their references before waiting for a controller that may be offline.
    if (notify) await invokeRequestor(item, 'end', { webRtcSessionId: item.id, reason }).catch(() => {});
  }
  function fail(item, code) {
    if (sessions.get(item.id) !== item) return;
    void end(item, code === 'matter_session_timeout' ? 1 : 0, true);
  }
  function selectStream(kind, request, owner) {
    return resources.select(kind, request, owner);
  }

  class ProtectAvServer extends CameraAvStreamManagementServer.with(...features) {
    async initialize() {
      // Allocations hold runtime encoder resources and do not survive a process restart.
      this.state.allocatedVideoStreams = [];
      if (audioEnabled) this.state.allocatedAudioStreams = [];
      this.state.allocatedSnapshotStreams = [];
      endpoint = this.endpoint;
      server = endpoint;
      while (server.owner) server = server.owner;
      this.reactTo(server.events.commissioning.fabricsChanged, (fabricIndex, action) => {
        if (action === 'deleted') {
          for (const session of resources.forgetFabric(fabricIndex)) {
            clearTimeout(session.timer);
            void media.closeSession(session.mediaId);
          }
          setImmediate(() => syncState().catch(() => {}));
        }
      });
      if (!audioEnabled) return;
      for (const [field, method] of [['microphoneMuted', 'setMicrophoneMuted'], ['microphoneVolumeLevel', 'setMicrophoneVolume']]) {
        if (typeof media[method] !== 'function') continue;
        await media[method](this.state[field]);
        this.reactTo(this.events[`${field}$Changing`], function (value) {
          beforeCommit(this, () => media[method](value), 'Audio control failed');
        });
      }
    }
    setStreamPriorities({ streamPriorities }) {
      if (streamPriorities.length !== 1 || streamPriorities[0] !== LIVE) reject(Status.ConstraintError, 'Only live view is supported');
      this.state.streamUsagePriorities = [LIVE];
    }
    videoStreamAllocate(request) {
      const actual = normalizeMatterVideoAllocation(request, { width, height, frameRate: fps, bitRate });
      const id = reserve('video', actor(this), actual);
      updateInBehavior(this, 'video');
      return { videoStreamId: id };
    }
    videoStreamDeallocate({ videoStreamId }) {
      resources.deallocate('video', videoStreamId, actor(this)); updateInBehavior(this, 'video');
    }
    audioStreamAllocate(request) {
      live(request.streamUsage);
      if (!audioEnabled) reject(Status.InvalidInState, 'Microphone is disabled');
      if (request.audioCodec !== 0 || request.channelCount !== 1 || request.sampleRate !== 48000 || request.bitDepth !== 16
        || request.bitRate < 16000 || request.bitRate > 64000) reject(Status.ConstraintError, 'Unsupported Opus parameters');
      const id = reserve('audio', actor(this), request);
      updateInBehavior(this, 'audio'); return { audioStreamId: id };
    }
    audioStreamDeallocate({ audioStreamId }) {
      resources.deallocate('audio', audioStreamId, actor(this)); updateInBehavior(this, 'audio');
    }
    snapshotStreamAllocate(request) {
      if (request.imageCodec !== 0 || request.maxFrameRate > 1 || request.watermarkEnabled || request.osdEnabled)
        reject(Status.ConstraintError, 'Unsupported snapshot parameters');
      validateResolution(request);
      const id = reserve('snapshot', actor(this), { imageCodec: 0, frameRate: request.maxFrameRate,
        minResolution: request.minResolution, maxResolution: request.maxResolution, quality: request.quality,
        encodedPixels: false, hardwareEncoder: false });
      updateInBehavior(this, 'snapshot'); return { snapshotStreamId: id };
    }
    snapshotStreamDeallocate({ snapshotStreamId }) {
      resources.deallocate('snapshot', snapshotStreamId, actor(this)); updateInBehavior(this, 'snapshot');
    }
    async captureSnapshot({ snapshotStreamId, requestedResolution }) {
      if (snapshotStreamId !== null) own(allocated.snapshot, snapshotStreamId, actor(this));
      else actor(this);
      if (requestedResolution.width < 2 || requestedResolution.height < 2) reject(Status.ConstraintError, 'Snapshot resolution is unsupported');
      try {
        const result = await media.snapshot({ width: Math.min(width, requestedResolution.width),
          height: Math.min(height, requestedResolution.height) });
        if (!result?.data?.length || result.data.length > 1000000 || !result.width || !result.height
          || result.width > Math.min(width, requestedResolution.width) || result.height > Math.min(height, requestedResolution.height))
          reject(Status.Failure, 'Snapshot unavailable');
        return { data: result.data, imageCodec: CameraAvStreamManagement.ImageCodec.Jpeg,
          resolution: { width: result.width, height: result.height } };
      } catch { reject(Status.Failure, 'Snapshot unavailable'); }
    }
  }
  class ProtectWebRtcServer extends WebRtcTransportProviderServer {
    initialize() { this.state.currentSessions = []; }
    async create(request, isOffer) {
      const owner = actor(this);
      validateMatterTransportRequest(request);
      const video = selectStream('video', request, owner), audio = selectStream('audio', request, owner);
      if (!video && !audio) reject(Status.InvalidCommand, 'An allocated media stream is required');
      if (isOffer && (typeof request.sdp !== 'string' || request.sdp.length > 65535)) reject(Status.ConstraintError, 'Invalid SDP');
      const item = resources.openSession({ owner, peerEndpointId: request.originatingEndpointId, video, audio }), { id } = item;
      const startMedia = () => {
        item.timer = setTimeout(() => fail(item, 'matter_session_timeout'), 30000);
        item.timer.unref?.();
        void (async () => {
        if (closed || !sessions.has(id)) return;
        await syncState();
        if (closed || sessions.get(id) !== item || item.ending) return;
        const v = video?.stream, a = audio?.stream;
        const result = await media.createSession({ id: item.mediaId, ...(isOffer ? { offer: request.sdp } : {}),
          video: v ? { id: v.videoStreamId, codec: 'h264', width: Math.min(width, v.maxResolution.width),
            height: Math.min(height, v.maxResolution.height), frameRate: Math.min(fps, v.maxFrameRate),
            bitRate: Math.min(bitRate, v.maxBitRate), keyFrameInterval: v.keyFrameInterval } : undefined,
          audio: a ? { id: a.audioStreamId, codec: 'opus', sampleRate: 48000, channels: 1, bitRate: a.bitRate } : undefined,
          iceServers: request.iceServers, iceTransportPolicy: request.iceTransportPolicy || 'all',
          onCandidate(candidate) {
            if (!candidate?.candidate || closed || sessions.get(id) !== item) return;
            const normalized = { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null,
              sdpmLineIndex: candidate.sdpMLineIndex ?? candidate.sdpmLineIndex ?? null };
            if (!item.ready) {
              if (item.pendingCandidates.length < 128) item.pendingCandidates.push(normalized);
            } else void invokeRequestor(item, 'iceCandidates', { webRtcSessionId: id, iceCandidates: [normalized] }).catch(() => fail(item, 'matter_signaling_failed'));
          },
          onState(state) {
            if (closed || sessions.get(id) !== item || item.ending) return;
            item.state = state;
            if (state === 'connected') {
              clearTimeout(item.timer);
              item.timer = setTimeout(() => fail(item, 'matter_session_timeout'), 60 * 60 * 1000);
              item.timer.unref?.();
            } else if (state === 'failed' || state === 'closed') void end(item, state === 'failed' ? 0 : 2, true);
          } });
        if (sessions.get(id) !== item || closed) { await media.closeSession(item.mediaId); return; }
        item.mediaCreated = true;
        while (item.pendingRemoteCandidates.length) await media.addCandidates(item.mediaId, item.pendingRemoteCandidates.splice(0, 32));
        const sdp = isOffer ? result.answer : result.offer;
        if (typeof sdp !== 'string' || !sdp.length) throw new Error('matter_signaling_failed');
        await invokeRequestor(item, isOffer ? 'answer' : 'offer', { webRtcSessionId: id, sdp });
        item.ready = true;
        if (item.pendingCandidates.length) await invokeRequestor(item, 'iceCandidates', {
          webRtcSessionId: id, iceCandidates: item.pendingCandidates.splice(0) });
        })().catch(() => fail(item, 'matter_signaling_failed'));
      };
      enrollMatterSession({ resources, item, transaction: this.context.transaction,
        publish: () => { this.state.currentSessions = [...sessions.values()].map(describeSession); },
        start: startMedia, afterRollback: () => {
          void Promise.resolve(media.closeSession(item.mediaId)).catch(() => {}).then(() => syncState()).catch(() => {});
        } });
      const response = { webRtcSessionId: id };
      if (!isOffer) response.deferredOffer = false;
      if ('videoStreamId' in request) response.videoStreamId = video?.stream.videoStreamId ?? null;
      if ('audioStreamId' in request) response.audioStreamId = audio?.stream.audioStreamId ?? null;
      return response;
    }
    solicitOffer(request) { return this.create(request, false); }
    provideOffer(request) { return this.create(request, true); }
    async provideAnswer({ webRtcSessionId, sdp }) {
      const item = sessionFor(this, webRtcSessionId);
      try { await media.provideAnswer(item.mediaId, sdp); }
      catch { reject(Status.Failure, 'Invalid WebRTC answer'); }
    }
    async provideIceCandidates({ webRtcSessionId, iceCandidates }) {
      const item = sessionFor(this, webRtcSessionId);
      if (!iceCandidates.length || iceCandidates.length > 32) reject(Status.ConstraintError, 'Invalid ICE candidates');
      const normalized = iceCandidates.map(candidate => ({ candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined, sdpMLineIndex: candidate.sdpmLineIndex ?? undefined }));
      if (!item.mediaCreated) {
        if (item.pendingRemoteCandidates.length + normalized.length > 128) reject(Status.ResourceExhausted, 'Too many pending ICE candidates');
        item.pendingRemoteCandidates.push(...normalized); return;
      }
      try { await media.addCandidates(item.mediaId, normalized); }
      catch { reject(Status.Failure, 'Invalid ICE candidate'); }
    }
    async endSession({ webRtcSessionId, reason }) {
      const item = sessionFor(this, webRtcSessionId);
      await end(item, reason, false, false);
      this.state.currentSessions = [...sessions.values()].map(describeSession);
      setImmediate(() => { void syncState().catch(() => {}); });
    }
  }


  const dimensions = {width, height};
  return {
    accessory: {
      UUID, displayName: matterLabel(camera.ufp.name || camera.accessoryName), manufacturer: 'Ubiquiti',
      model: matterLabel(camera.ufp.marketName || camera.ufp.type || 'UniFi Protect Camera'), serialNumber: camera.mac,
      deviceType: CameraDevice.with(ProtectAvServer, ProtectWebRtcServer, WebRtcTransportRequestorClient),
      clusters: {
        cameraAvStreamManagement: {
          maxContentBufferSize: 1000000, maxNetworkBandwidth: 5000000 * maxStreams, maxConcurrentEncoders: maxStreams,
          maxEncodedPixelRate: width * height * fps * maxStreams, supportedStreamUsages: [LIVE], streamUsagePriorities: [LIVE],
          videoSensorParams: {sensorWidth: width, sensorHeight: height, maxFps: fps},
          minViewportResolution: {width: 160, height: 120}, currentFrameRate: fps,
          rateDistortionTradeOffPoints: [{codec: 0, resolution: dimensions, minBitRate: 64000}],
          viewport: {x1: 0, y1: 0, x2: width, y2: height},
          ...(audioEnabled ? {microphoneCapabilities: {maxNumberOfChannels: 1, supportedCodecs: [0],
            supportedSampleRates: [48000], supportedBitDepths: [16]}, microphoneMuted: false,
            microphoneVolumeLevel: 100, microphoneMinLevel: 0, microphoneMaxLevel: 100} : {}),
          snapshotCapabilities: [{resolution: dimensions, maxFrameRate: 1, imageCodec: 0, requiresEncodedPixels: false}],
        }, webRtcTransportProvider: {currentSessions: []}
      }
    },
    async close() {
      closed = true;
      for (const item of sessions.values()) clearTimeout(item.timer);
      resources.clear();
      await media.close();
    }
  };
}
