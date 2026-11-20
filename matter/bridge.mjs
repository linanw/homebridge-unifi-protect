import { cameraAccessory } from './camera.mjs';
import { MatterMedia } from './media.mjs';

const plugin = 'homebridge-unifi-protect', platform = 'UniFi Protect';

// The NVR owns discovery and removal. Only publish camera projections it has admitted.
export function startMatterCameras(api, controllers, ffmpegPath, log) {
  const active = new Map();
  let stopping = false, pending, timer;
  async function reconcile() {
    const present = new Set();
    const additions = new Map();
    for (const nvr of controllers) {
      for (const camera of nvr.configuredDevices.values()) {
        if (typeof camera.livestream !== 'function') continue;
        const uuid = api.hap.uuid.generate(plugin + ':camera:' + camera.mac);
        present.add(uuid);
        let item = active.get(uuid);
        if (item && item.camera !== camera) {
          await remove(uuid, item);
          item = undefined;
        }
        if (!item) {
          const media = new MatterMedia({camera, ffmpegPath, config: {enableAudio: camera.ufp.featureFlags.hasMic && camera.hasFeature('Audio')}});
          const entry = cameraAccessory(camera, uuid, media);
          item = {...entry, camera, reachable: true};
          additions.set(uuid, item);
          continue;
        }
        if (item.reachable !== camera.isReachable) {
          await api.matter.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', {reachable: camera.isReachable});
          item.reachable = camera.isReachable;
        }
      }
    }
    if (additions.size) {
      const items = [...additions.values()];
      try {
        await api.matter.registerPlatformAccessories(plugin, platform, items.map(item => item.accessory));
      } catch (error) {
        await Promise.allSettled(items.map(item => item.close()));
        throw error;
      }
      for (const [uuid, item] of additions) active.set(uuid, item);
      log.info('Published %d Matter camera accessories.', items.length);
    }
    for (const [id, item] of active) if (!present.has(id)) await remove(id, item);
  }
  async function remove(id, item) {
    await api.matter.unregisterPlatformAccessories(plugin, platform, [item.accessory]);
    active.delete(id);
    await item.close();
  }
  async function poll() {
    try { await reconcile(); } catch (error) { log.warn('Matter camera registration: %s', error.message); }
    finally { if (!stopping) timer = setTimeout(() => { pending = poll(); }, 5000); }
  }
  pending = poll();
  api.on('shutdown', async () => {
    stopping = true;
    clearTimeout(timer);
    await pending;
    await Promise.allSettled([...active.values()].map(item => item.close()));
  });
}
