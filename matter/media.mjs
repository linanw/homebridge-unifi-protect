// WebRTC transport adapted from linanw’s MIT-licensed Mijia plugin.
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from 'werift';
import { createSocket } from 'node:dgram';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';

const fault = reason => Object.assign(new Error(reason), { reason });
const integer = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const timer = (callback, ms) => { const value = setTimeout(callback, ms); value.unref(); return value; };
const isRtp = bytes => Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.length <= 2048 && (bytes[0] >> 6) === 2;
// The current Matter secure session encrypts at most 65,535 bytes in one message.
// Reserve space for the exchange header and the CaptureSnapshotResponse TLV.
export const MATTER_SNAPSHOT_MAX_BYTES = 63 * 1024;
const exceptionTypes = new Set(['Error', 'TypeError', 'RangeError', 'OperationError', 'InvalidStateError', 'InvalidModificationError', 'InvalidAccessError', 'NotSupportedError', 'SyntaxError', 'AbortError']);
function sdp(value) {
  if (typeof value !== 'string' || value.length > 65536 || !value.startsWith('v=0') || !value.includes('a=fingerprint:') || !value.includes('a=ice-ufrag:')) throw fault('invalid_sdp');
  return value;
}
function jpegSize(data) {
  if (data.length < 10 || data[0] !== 0xff || data[1] !== 0xd8) throw fault('snapshot_invalid');
  for (let offset = 2; offset + 4 <= data.length;) {
    if (data[offset++] !== 0xff) throw fault('snapshot_invalid');
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset + 3 > data.length) break;
    const marker = data[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
      const height = data.readUInt16BE(offset + 3), width = data.readUInt16BE(offset + 5);
      if (width && height && width <= 4096 && height <= 4096) return { width, height };
      break;
    }
    offset += length;
  }
  throw fault('snapshot_invalid');
}

function encodeSnapshot(ffmpegPath, data, width, height, quality, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0',
      '-vf', `scale=${width}:${height}`, '-frames:v', '1', '-threads', '1', '-pix_fmt', 'yuvj420p',
      '-q:v', String(quality), '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'],
      {encoding: 'buffer', signal, maxBuffer: MATTER_SNAPSHOT_MAX_BYTES}, (error, stdout) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && stdout.length === MATTER_SNAPSHOT_MAX_BYTES) resolve(null);
        else if (error) reject(error);
        else resolve(stdout);
      });
    // FFmpeg may close stdin early after one frame or when maxBuffer terminates
    // the attempt. The execFile callback owns the result and process errors.
    child.stdin.on('error', () => {});
    child.stdin.end(data);
  });
}
function codecConfig() {
  return { video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
    parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }] })],
  audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111,
    parameters: 'minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0' })] };
}

/** Packet-oriented WebRTC transport. The bundled FFmpeg owns media coding; only
 * loopback UDP carries clear RTP. ICE, DTLS, SRTP and retransmission use werift. */
export class MatterMedia {
  constructor({ camera, ffmpegPath, config = {}, spawnProcess = spawn, connectTimeoutMs = 20000, mediaTimeoutMs = 15000 } = {}) {
    this.camera = camera; this.ffmpegPath = ffmpegPath;
    this.config = config; this.spawnProcess = spawnProcess;
    this.connectTimeoutMs = connectTimeoutMs; this.mediaTimeoutMs = mediaTimeoutMs;
    this.microphoneMuted = config.enableAudio === false;
    this.microphoneVolume = 100; this.closed = false;
    this.maxStreams = integer(config.maxStreams, 2, 1, 4);
    this.sessions = new Map(); this.sources = new Map();
    this.counters = { sessions: 0, failures: 0, videoPackets: 0, audioPackets: 0, state: 'idle' };
  }
  // Kept for consumers that inspect the original single-view transport.
  get session() { return this.sessions.values().next().value; }
  status() {
    const sources = [...this.sources.values()];
    return { ...this.counters, active: this.sessions.size > 0, activeSessions: this.sessions.size,
      maxSessions: this.maxStreams, sourceJobs: sources.reduce((count, source) => count + source.jobs.size, 0),
      sourceSockets: sources.reduce((count, source) => count + source.sockets.size, 0),
      activeSources: sources.length, videoSources: sources.filter(source => source.kind === 'video').length,
      audioSources: sources.filter(source => source.kind === 'audio').length,
      microphoneMuted: this.microphoneMuted };
  }
  emit(session, state) {
    this.counters.state = state === 'closed' && this.sessions.size ? ([...this.sessions.values()].some(value => value.peer.connectionState === 'connected') ? 'connected' : 'connecting') : state;
    try { session.onState?.(state); } catch {}
  }
  alive(session) { return this.sessions.get(String(session.id)) === session && !session.closed && !this.closed; }
  fail(session, reason = 'media_unavailable') {
    if (!this.alive(session)) return;
    this.counters.failures++; this.counters.lastFailure = reason; this.emit(session, 'failed'); void this.closeSession(session.id, session);
  }
  async createSession({ id, offer, video, audio, onCandidate, onState, iceServers, iceTransportPolicy } = {}) {
    if (this.closed) throw fault('closed');
    if (this.sessions.has(String(id))) throw fault('duplicate_session');
    if (this.sessions.size >= this.maxStreams) throw fault('session_busy');
    if (iceTransportPolicy !== undefined && iceTransportPolicy !== 'all') throw fault('relay_unavailable');
    if (iceServers !== undefined && (!Array.isArray(iceServers) || iceServers.length)) throw fault('ice_servers_unsupported');
    if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).length || String(id).length > 160 || (!video && !audio)) throw fault('invalid_session');
    if ((video && (typeof video !== 'object' || (video.codec !== undefined && video.codec !== 'h264')))
      || (audio && (typeof audio !== 'object' || (audio.codec !== undefined && audio.codec !== 'opus')))) throw fault('unsupported_codec');
    if (offer !== undefined) sdp(offer);
    const codecs = codecConfig();
    const peer = new RTCPeerConnection({ codecs, bundlePolicy: 'max-bundle', iceServers: [], iceUseTcp: false,
      iceAdditionalHostAddresses: this.config.matterLoopbackIce === true ? ['127.0.0.1'] : undefined });
    const session = { id, peer, onCandidate, onState, sockets: new Set(), jobs: new Set(), candidateCount: 0,
      video: video ? { width: integer(video.width, 640, 2, 1280), height: integer(video.height, 360, 2, 720),
        frameRate: integer(video.frameRate, 15, 1, 30), bitRate: integer(video.bitRate, 512000, 64000, 2000000),
        keyFrameInterval: integer(video.keyFrameInterval, 1000, 200, 4000) } : undefined,
      audio: audio && this.config.enableAudio !== false ? { channels: 1, bitRate: integer(audio.bitRate, 24000, 16000, 64000) } : undefined };
    if (!session.video && !session.audio) { await peer.close(); throw fault('audio_disabled'); }
    this.sessions.set(String(id), session); this.counters.sessions++; this.emit(session, 'connecting');
    session.connectTimer = timer(() => this.fail(session, 'webrtc_timeout'), this.connectTimeoutMs);
    session.lifeTimer = timer(() => this.closeSession(id, session), 30 * 60 * 1000);
    peer.onIceCandidate.subscribe(candidate => {
      if (!candidate || !this.alive(session) || session.candidateCount++ >= 128) return;
      try { onCandidate?.({ candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? undefined, sdpMLineIndex: candidate.sdpMLineIndex ?? undefined }); } catch {}
    });
    peer.connectionStateChange.subscribe(state => {
      if (!this.alive(session)) return;
      if (state === 'connected') {
        clearTimeout(session.connectTimer); clearTimeout(session.disconnectTimer); this.emit(session, 'connected');
        if (!session.started) { session.started = true; void this.startMedia(session).catch(() => this.fail(session)); }
      } else if (state === 'failed' || state === 'closed') this.fail(session, 'webrtc_failed');
      else if (state === 'disconnected') { clearTimeout(session.disconnectTimer); session.disconnectTimer = timer(() => this.fail(session, 'webrtc_disconnected'), 5000); }
    });
    try {
      // Install source codec constraints before applying an offer. With no local
      // source werift chooses the first H264 MIME match, which can be a different
      // profile from the encoded RTP source in a browser's multi-profile offer.
      for (const [kind, enabled] of [['video', session.video], ['audio', session.audio]]) {
        if (!enabled) continue;
        session.negotiationStage = `replace_${kind}_track`;
        const track = new MediaStreamTrack({ kind, codec: codecs[kind][0] }); session[`${kind}Track`] = track;
        const direction = 'sendonly';
        session[`${kind}Sender`] = peer.addTransceiver(track, { direction }).sender;
      }
      if (offer !== undefined) {
        session.negotiationStage = 'remote_description'; await peer.setRemoteDescription({ type: 'offer', sdp: offer });
        for (const kind of ['video', 'audio']) {
          if (session[kind] && !peer.getTransceivers().some(t => t.sender === session[`${kind}Sender`] && t.mid != null && !t.stopped && !t.rejected)) throw fault('media_not_offered');
        }
      }
      session.negotiationStage = offer !== undefined ? 'create_answer' : 'create_offer';
      const description = offer !== undefined ? await peer.createAnswer() : await peer.createOffer();
      session.negotiationStage = 'local_description'; await peer.setLocalDescription(description);
      if (!this.alive(session)) throw fault('session_closed');
      return offer !== undefined ? { answer: peer.localDescription.sdp } : { offer: peer.localDescription.sdp };
    } catch (error) {
      const reason = error?.reason === 'media_not_offered' ? 'media_not_offered' : 'negotiation_failed';
      if (!this.alive(session)) { await this.closeSession(id, session); throw fault('session_closed'); }
      this.negotiationFailure(session, error, reason);
      await this.closeSession(id, session); throw fault(reason);
    }
  }
  negotiationFailure(session, error, reason = 'negotiation_failed') {
    this.counters.failures++; this.counters.lastFailure = reason;
    this.counters.lastFailureStage = session.negotiationStage || 'create_offer';
    this.counters.lastFailureType = exceptionTypes.has(error?.name) ? error.name : 'Error';
  }
  getSession(id) { const session = this.sessions.get(String(id)); if (!session || session.closed) throw fault('unknown_session'); return session; }
  async provideAnswer(id, value) {
    const session = this.getSession(id); sdp(value);
    if (session.peer.signalingState !== 'have-local-offer') throw fault('invalid_session_state');
    session.negotiationStage = 'remote_answer';
    try { await session.peer.setRemoteDescription({ type: 'answer', sdp: value }); }
    catch (error) { if (!this.alive(session)) throw fault('session_closed'); this.negotiationFailure(session, error); await this.closeSession(id, session); throw fault('negotiation_failed'); }
  }
  async addCandidates(id, candidates) {
    const session = this.getSession(id);
    if (!Array.isArray(candidates) || candidates.length > 32 || (session.remoteCandidates || 0) + candidates.length > 128) throw fault('invalid_candidates');
    for (const value of candidates) {
      if (!value || typeof value.candidate !== 'string' || value.candidate.length > 2048
        || (value.candidate && !value.candidate.startsWith('candidate:')) || (value.sdpMid != null && typeof value.sdpMid !== 'string')) throw fault('invalid_candidates');
      try { await session.peer.addIceCandidate({ candidate: value.candidate, sdpMid: value.sdpMid ?? undefined, sdpMLineIndex: value.sdpMLineIndex ?? value.sdpmLineIndex }); }
      catch { throw fault('invalid_candidates'); }
    }
    session.remoteCandidates = (session.remoteCandidates || 0) + candidates.length;
  }
  ownerAlive(owner) { return owner.kind ? this.sourceAlive(owner) : this.alive(owner); }
  ownerFail(owner, reason) { if (owner.kind) this.failSource(owner, reason); else this.fail(owner, reason); }
  async socket(owner) {
    const socket = createSocket('udp4'); owner.sockets.add(socket);
    socket.on('error', () => this.ownerFail(owner, 'udp_error'));
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
    if (!this.ownerAlive(owner)) { owner.sockets.delete(socket); try { socket.close(); } catch {} throw fault('session_closed'); }
    return socket;
  }
  job(owner, args, failure = true) {
    let child;
    try { child = this.spawnProcess(this.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw fault('ffmpeg_unavailable'); }
    owner.jobs.add(child); child.stdin?.on('error', () => {}); child.stdout?.on('error', () => {});
    child.stderr?.on('data', () => {}); child.on('error', () => { if (failure) this.ownerFail(owner, 'ffmpeg_unavailable'); });
    child.once('close', () => { owner.jobs.delete(child); if (failure && this.ownerAlive(owner) && !child.intentionalStop) this.ownerFail(owner, 'ffmpeg_exit'); });
    return child;
  }
  kill(owner, child) {
    if (!child) return; child.intentionalStop = true; owner.jobs.delete(child);
    try { child.kill('SIGTERM'); } catch {}
    timer(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} } }, 1500);
  }
  sourceAlive(source) { return this.sources.get(source.key) === source && !source.closed && !this.closed && source.subscribers.size > 0; }
  attachSource(session, kind) {
    if (!this.alive(session) || (kind === 'audio' && this.microphoneMuted)) return;
    if (session[`${kind}Source`]) return session[`${kind}Source`];
    const profile = kind === 'video' ? session.video : { ...session.audio, volume: this.microphoneVolume };
    const key = `${kind}:${JSON.stringify(profile)}`;
    let source = this.sources.get(key);
    if (!source || source.closed) {
      source = { key, kind, profile, subscribers: new Set(), jobs: new Set(), sockets: new Set(), generation: 0 };
      this.sources.set(key, source);
    }
    source.subscribers.add(session); session[`${kind}Source`] = source;
    if (kind === 'audio') session.audioSender.replaceRTP({ sequenceNumber: 0, timestamp: 0 }, true, 960);
    if (!source.starting && !source.started) {
      source.started = true;
      if (kind === 'video') source.starting = this.startVideoSource(source).catch(() => this.failSource(source, 'media_unavailable'));
      else void this.startAudioSource(source);
    }
    return source;
  }
  detachSource(session, kind) {
    const source = session[`${kind}Source`]; session[`${kind}Source`] = undefined;
    if (!source) return;
    source.subscribers.delete(session);
    if (!source.subscribers.size) this.closeSource(source);
  }
  stopSourceMedia(source) {
    source.generation++; clearTimeout(source.poll); clearTimeout(source.deadline); source.poll = undefined;
    source.child = undefined;
    for (const child of [...source.jobs]) this.kill(source, child);
    for (const socket of source.sockets) { try { socket.close(); } catch {} } source.sockets.clear();
  }
  closeSource(source) {
    if (source.closed) return;
    source.closed = true;
    if (this.sources.get(source.key) === source) this.sources.delete(source.key);
    this.stopSourceMedia(source);
    for (const session of source.subscribers) if (session[`${source.kind}Source`] === source) session[`${source.kind}Source`] = undefined;
    source.subscribers.clear();
  }
  failSource(source, reason = 'media_unavailable') {
    if (!this.sourceAlive(source)) return;
    const sessions = [...source.subscribers]; this.closeSource(source);
    for (const session of sessions) this.fail(session, reason);
  }
  fanout(source, bytes, payloadType) {
    if (!this.sourceAlive(source) || !isRtp(bytes) || (bytes[1] & 0x7f) !== payloadType || (source.kind === 'audio' && this.microphoneMuted)) return;
    clearTimeout(source.deadline);
    for (const session of [...source.subscribers]) {
      if (!this.alive(session) || session[`${source.kind}Source`] !== source) continue;
      this.counters[`${source.kind}Packets`]++;
      // Each peer has independent SSRC, sequence mapping, retransmission and SRTP.
      // writeRtp parses/clones its input; no mutable RTP packet crosses peers.
      try { session[`${source.kind}Track`].writeRtp(bytes); } catch { this.fail(session, 'media_unavailable'); }
    }
  }
  async startMedia(session) {
    if (!this.alive(session)) return;
    if ((session.video && !session.videoSender.codec) || (session.audio && !session.audioSender.codec)) throw fault('codec_unavailable');
    if (session.video) this.attachSource(session, 'video');
    if (session.audio) this.startAudio(session);
  }
  async startVideoSource(source) {

    if (!this.sourceAlive(source)) return;
    const socket = await this.socket(source), v = source.profile;
    if (!this.sourceAlive(source)) return;
    source.deadline = timer(() => this.failSource(source, 'video_timeout'), this.mediaTimeoutMs);
    socket.on('message', bytes => this.fanout(source, bytes, 96));
    source.child = this.job(source, ['-analyzeduration', '1000000', '-probesize', '2000000', '-f', 'mp4', '-i', 'pipe:0',
      '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level:v', '3.1',
      '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2', '-vf', `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2`,
      '-r', String(v.frameRate), '-b:v', String(v.bitRate), '-maxrate', String(v.bitRate), '-bufsize', String(v.bitRate * 2),
      '-g', String(Math.max(1, Math.round(v.frameRate * v.keyFrameInterval / 1000))), '-bf', '0', '-x264-params', 'repeat-headers=1',
      '-payload_type', '96', '-f', 'rtp', `rtp://127.0.0.1:${socket.address().port}?pkt_size=1200`]);
    this.feedCamera(source, source.child);
  }
  startAudio(session) { if (this.alive(session) && !this.microphoneMuted && session.audio) this.attachSource(session, 'audio'); }
  async startAudioSource(source) {
    if (!this.sourceAlive(source) || this.microphoneMuted || source.child || source.starting) return;
    const generation = source.generation; source.starting = true;
    try {
      const socket = await this.socket(source);
      if (!this.sourceAlive(source) || this.microphoneMuted || generation !== source.generation) { source.sockets.delete(socket); try { socket.close(); } catch {} return; }
      for (const session of source.subscribers) session.audioSender.replaceRTP({ sequenceNumber: 0, timestamp: 0 }, true, 960);
      socket.on('message', bytes => this.fanout(source, bytes, 111));
      const child = this.job(source, ['-analyzeduration', '1000000', '-probesize', '2000000', '-f', 'mp4', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-af', `volume=${source.profile.volume / 100}`, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-application', 'lowdelay', '-frame_duration', '20',
        '-b:a', String(source.profile.bitRate), '-payload_type', '111', '-f', 'rtp', `rtp://127.0.0.1:${socket.address().port}?pkt_size=1200`], false);
      source.child = child;
      this.feedCamera(source, child);
      child.on('error', () => { if (source.child === child) this.restartAudioSource(source); });
      child.once('close', () => { if (source.child === child) this.restartAudioSource(source); });
    } catch { if (this.sourceAlive(source)) this.pollAudio(source, 2000); }
    finally {
      source.starting = false;
      if (this.sourceAlive(source) && !this.microphoneMuted && !source.child && !source.poll) this.pollAudio(source, 500);
    }
  }
  pollAudio(source, ms) {
    if (!this.sourceAlive(source)) return;
    clearTimeout(source.poll);
    source.poll = timer(() => { source.poll = undefined; void this.startAudioSource(source); }, ms);
  }
  stopAudio(session) { this.detachSource(session, 'audio'); }
  restartAudioSource(source) {
    this.stopSourceMedia(source);
    if (this.sourceAlive(source) && !this.microphoneMuted) this.pollAudio(source, 500);
  }
  restartAudio(session) { this.stopAudio(session); if (this.alive(session) && !this.microphoneMuted && session.started) this.startAudio(session); }
  feedCamera(source, child) {
    const abort = new AbortController();
    child.once('close', () => abort.abort());
    const feed = async () => {
      const camera = this.camera;
      const profile = camera.selectChannel(640, 360, {}) ?? camera.selectSubstrateChannel();
      if (!profile || !camera.isReachable) throw fault('camera_unavailable');
      const subscription = camera.livestream(profile, {signal: abort.signal});
      let started = false;
      try {
        for await (const segment of subscription) {
          if (abort.signal.aborted || segment.discontinuity) break;
          if (segment.type === 'init') continue;
          if (!started) {
            if (!subscription.initSegment) throw fault('missing_stream_header');
            child.stdin.write(subscription.initSegment.data);
            started = true;
          }
          if (!child.stdin.write(segment.data)) await once(child.stdin, 'drain', {signal: abort.signal});
        }
      } finally {
        child.stdin.end();
        await subscription[Symbol.asyncDispose]();
      }
    };
    void feed().catch(() => { if (this.sourceAlive(source) && !abort.signal.aborted) this.failSource(source, 'camera_unavailable'); });
  }
  setMicrophoneMuted(value) { this.microphoneMuted = value === true || this.config.enableAudio === false; for (const session of this.sessions.values()) this.stopAudio(session); if (!this.microphoneMuted) for (const session of this.sessions.values()) if (session.started) this.startAudio(session); }
  setMicrophoneVolume(value) { this.microphoneVolume = clamp(integer(value, 100, 0, 100), 0, 100); for (const session of this.sessions.values()) this.stopAudio(session); if (!this.microphoneMuted) for (const session of this.sessions.values()) if (session.started) this.startAudio(session); }
  async snapshot({ width = 320, height = 180 } = {}) {
    if (this.closed) throw fault('closed');
    width = integer(width, 320, 2, 1280); height = integer(height, 180, 2, 720);
    if (!this.camera.isReachable) throw fault('camera_unavailable');
    // Use Protect's existing coalesced capture (timeshift, NVR JPEG, then RTSP).
    let data = await this.camera.stream?.snapshot.getSnapshot({width, height});
    if (!data) data = await this.camera.snapshotFromController({width, height, signal: AbortSignal.timeout(6000)});
    if (!Buffer.isBuffer(data) || data.length > 8 * 1024 * 1024) throw fault('snapshot_invalid');
    const size = jpegSize(data);
    const fit = Math.min(1, width / size.width, height / size.height);
    if (fit === 1 && data.length <= MATTER_SNAPSHOT_MAX_BYTES) return { data, ...size };
    const signal = AbortSignal.timeout(6000);
    // Re-encode the same captured frame. Preserve resolution while adjusting JPEG
    // quality first; smaller frames give detailed scenes a bounded fallback.
    for (const [scale, quality] of [[1, 4], [1, 9], [1, 16], [0.5, 9], [0.25, 12]]) {
      const targetWidth = Math.max(1, Math.round(size.width * fit * scale));
      const targetHeight = Math.max(1, Math.round(size.height * fit * scale));
      const encoded = await encodeSnapshot(this.ffmpegPath, data, targetWidth, targetHeight, quality, signal);
      if (encoded) return { data: encoded, ...jpegSize(encoded) };
    }
    throw fault('snapshot_too_large');
  }
  async closeSession(id, expected) {
    const session = this.sessions.get(String(id)); if (!session || session.closed || (expected && session !== expected)) return;
    session.closed = true; this.sessions.delete(String(id));
    this.detachSource(session, 'video');
    for (const name of ['connectTimer', 'disconnectTimer', 'lifeTimer', 'videoDeadline']) clearTimeout(session[name]);
    this.stopAudio(session);
    for (const child of [...session.jobs]) this.kill(session, child);
    for (const socket of session.sockets) { try { socket.close(); } catch {} } session.sockets.clear();
    session.videoTrack?.stop(); session.audioTrack?.stop();
    try { await session.peer.close(); } catch {}
    this.emit(session, 'closed');
  }
  async close() { this.closed = true; await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id))); for (const source of [...this.sources.values()]) this.closeSource(source); }
}
export const createMatterMedia = options => new MatterMedia(options);
