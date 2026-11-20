import assert from 'node:assert/strict';
import test from 'node:test';
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
