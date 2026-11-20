// Homebridge starts the child bridge before constructing its platforms. Configure the
// owning Matter node during plugin initialization so large camera commands can use TCP.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';

export async function configureCameraTransport(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const host = pathToFileURL(createRequire(import.meta.url).resolve('homebridge')).href;
  const { Environment } = await import(resolve('@matter/main', host));
  for (const platform of config.platforms ?? []) {
    if (platform.platform !== 'UniFi Protect') continue;
    const username = platform._bridge?.username;
    if (typeof username !== 'string' || !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(username)) continue;
    Environment.default.vars.set('nodes.' + username.replaceAll(':', '') + '.network.tcp', true);
  }
}
