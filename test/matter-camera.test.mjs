import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import bundledFfmpeg from 'ffmpeg-for-homebridge';
import { MATTER_SNAPSHOT_MAX_BYTES, MatterMedia } from '../matter/media.mjs';
import { cameraAccessory, enrollMatterSession } from '../matter/camera.mjs';

for (const version of ['0.17', '0.18']) {
  test('starts media once after a Matter ' + version + ' commit', () => {
    const item = { id: 5 }, sessions = new Map([[5, item]]);
    let participant, starts = 0;
    enrollMatterSession({ resources: {sessions}, item, publish() {},
      transaction: { addParticipants(value) { participant = value; } },
      schedule: callback => callback(), start() { starts++; } });
    assert.equal(starts, 0);
    if (version === '0.17') participant.postCommit();
    else participant.conclusion('committed');
    assert.equal(starts, 1);
  });
}

test('keeps a long Unicode product and camera name within the Matter field limit', () => {
  const name = '室外摄像头'.repeat(8);
  const camera = {ufp: {name, marketName: name}, mac: 'mock-camera'};
  const {accessory} = cameraAccessory(camera, 'fixture-camera', {config: {enableAudio: false}});
  for (const label of [accessory.model, accessory.displayName]) {
    assert.ok(label.length && name.startsWith(label) && Buffer.byteLength(label) <= 32);
  }
});

const ffmpegPath = bundledFfmpeg || 'ffmpeg';

function syntheticJpeg(width, height, noiseMask) {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    pixels[i] = (seed >>> 24) & noiseMask;
  }
  return execFileSync(ffmpegPath, ['-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', width + 'x' + height, '-i', 'pipe:0', '-frames:v', '1', '-threads', '1',
    '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'], { input: pixels, maxBuffer: 4 * 1024 * 1024 });
}

function snapshotFrom(data, width, height) {
  const camera = { isReachable: true, stream: {snapshot: {getSnapshot: async () => data}} };
  return new MatterMedia({camera, ffmpegPath}).snapshot({width, height});
}

function assertFitsAndDecodes(frame) {
  assert.ok(frame.data.length <= MATTER_SNAPSHOT_MAX_BYTES);
  assert.ok(frame.data.length + 1023 <= 65535, 'leave room for the inline Matter response headers');
  // framemd5 forces a complete decode, independent of the adapter's JPEG header parser.
  const decoded = execFileSync(ffmpegPath, ['-v', 'error', '-xerror', '-i', 'pipe:0',
    '-frames:v', '1', '-threads', '1', '-f', 'framemd5', 'pipe:1'], {input: frame.data, encoding: 'utf8'});
  assert.ok(decoded.includes('#dimensions 0: ' + frame.width + 'x' + frame.height + '\n'));
  assert.match(decoded, /^0,/m);
}

test('keeps an already fitting Matter JPEG byte-for-byte', async () => {
  const original = syntheticJpeg(640, 360, 0);
  const frame = await snapshotFrom(original, 640, 360);
  assert.deepEqual(frame.data, original);
  assert.deepEqual([frame.width, frame.height], [640, 360]);
  assertFitsAndDecodes(frame);
});

test('re-encodes a detailed 640×360 snapshot to fit before lowering resolution', async () => {
  const original = syntheticJpeg(640, 360, 31);
  assert.ok(original.length > 65535 && original.length < 1000000);
  const frame = await snapshotFrom(original, 640, 360);
  assert.deepEqual([frame.width, frame.height], [640, 360]);
  assertFitsAndDecodes(frame);
});

test('shrinks a high-entropy snapshot and reports its actual dimensions', async () => {
  const original = syntheticJpeg(1280, 720, 255);
  const frame = await snapshotFrom(original, 1280, 720);
  assert.ok(frame.width < 1280 && frame.height < 720);
  assert.equal(frame.width * 720, frame.height * 1280);
  assertFitsAndDecodes(frame);
});

test('rejects input without a JPEG frame', async () => {
  await assert.rejects(snapshotFrom(Buffer.alloc(64), 640, 360), /snapshot_invalid/);
});
