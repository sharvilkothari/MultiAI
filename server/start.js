/**
 * Startup script — handles everything in one command:
 *  1. Quits Chrome gracefully (it will restore tabs on relaunch)
 *  2. Relaunches Chrome with --remote-debugging-port=9222
 *  3. Waits for CDP to be ready
 *  4. Starts the Express server
 *  5. Opens localhost:3000 in the user's Chrome
 */

import { execSync, spawn } from 'child_process';
import { createLogger } from './utils/logger.js';

const log = createLogger('Startup');
const CDP_PORT = 9222;

async function waitForCDP(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function isCDPAvailable() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return res.ok;
  } catch { return false; }
}

async function main() {
  // Check if Chrome already has CDP enabled
  if (await isCDPAvailable()) {
    log.info('Chrome is already running with CDP enabled');
  } else {
    log.info('Restarting Chrome with remote debugging enabled…');

    // Gracefully quit Chrome (saves session — Chrome will restore tabs)
    try {
      execSync('osascript -e \'quit app "Google Chrome"\'', { stdio: 'ignore' });
    } catch { /* Chrome might not be running */ }

    // Wait for Chrome to fully quit
    await new Promise(r => setTimeout(r, 2000));

    // Relaunch Chrome with remote debugging
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    spawn(chromePath, [`--remote-debugging-port=${CDP_PORT}`], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    log.info('Waiting for Chrome to start…');
    const ready = await waitForCDP();
    if (!ready) {
      log.error('Chrome did not start with CDP. Please ensure Google Chrome is installed.');
      process.exit(1);
    }
    log.info('Chrome is ready with CDP on port ' + CDP_PORT);
  }

  // Now start the Express server (it will connect via CDP)
  await import('./index.js');
}

main().catch(err => {
  log.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
