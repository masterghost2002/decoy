/**
 * Opens the playground with everything already wired up.
 *
 *   pnpm --filter @decoy/extension build
 *   pnpm playground
 *
 * It launches a real Chrome with the built extension loaded, seeds the
 * playground's rule set through `chrome.storage.local`, serves the harness and
 * its fixture server, and opens the page. Then it stays out of the way until
 * you press Ctrl-C.
 *
 * The seeding is why this exists rather than a plain static server: the rule
 * set is over a hundred rules, and nobody is going to type those into the UI to
 * try a mocking tool.
 *
 * Env:
 *   PLAYGROUND_PORT   the harness origin (default 4400)
 *   PLAYGROUND_DEBUG_PORT   the CDP port (default 9444)
 *   HEADLESS=1        run without a window, for a smoke check
 */
import { fileURLToPath } from 'node:url';

import { buildConfig, STORAGE_KEY } from '../../../playground/rules.mjs';
import { startAltOriginServer, startPlaygroundServer } from '../../../playground/server.mjs';
import { evaluate, launchWithExtension, seedConfig, sleep } from './lib/browser.mjs';

const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

const PORT = Number(process.env.PLAYGROUND_PORT ?? 4400);
/* The cross-origin cases need a second origin that sends no CORS headers. */
const ALT_PORT = PORT + 1;
const DEBUG_PORT = Number(process.env.PLAYGROUND_DEBUG_PORT ?? 9444);
const HEADLESS = process.env.HEADLESS === '1';

async function main() {
  const servers = [
    await startPlaygroundServer({ port: PORT, altPort: ALT_PORT }),
    await startAltOriginServer({ port: ALT_PORT }),
  ];
  const origin = `http://127.0.0.1:${String(PORT)}`;
  console.log(`playground: ${origin}`);

  let session;
  try {
    session = await launchWithExtension({
      distDir: DIST_DIR,
      debugPort: DEBUG_PORT,
      headed: !HEADLESS,
      windowSize: '1440,960',
    });
  } catch (error) {
    if (error.code === 'NO_CHROME') {
      console.error(`\n${error.message}\n`);
      console.error(
        [
          'You can still use the playground in a Chrome you already have:',
          '',
          `  1. leave this running and open ${origin}`,
          '  2. load apps/extension/dist as an unpacked extension',
          '  3. open the Rule set tab and copy the seeding snippet into the',
          "     extension page's DevTools console",
          '',
          'Press Ctrl-C to stop the server.',
        ].join('\n'),
      );
      await new Promise(() => {});
      return;
    }
    throw error;
  }

  console.log(`browser:    ${session.chromePath}`);
  console.log(`extension:  ${session.extensionId}`);

  const seeded = await seedConfig(
    session.cdp,
    session.workerSession,
    STORAGE_KEY,
    buildConfig({ port: PORT, altPort: ALT_PORT }),
  );
  console.log(`rules:      ${String(seeded)} seeded`);

  // The playground first, then the extension's own tab beside it: the whole
  // point is to watch one while clicking the other.
  const open = async (url) => {
    const { targetId } = await session.cdp.send('Target.createTarget', { url });
    return targetId;
  };
  await open(`chrome-extension://${session.extensionId}/tab.html`);
  await sleep(300);
  await open(origin);

  console.log('');
  console.log("Two tabs are open: the playground, and Decoy's own workspace.");
  console.log('Press Ctrl-C to stop.');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const server of servers) server.close();
    await session.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (HEADLESS) {
    // A smoke check: prove the page loaded and the rules arrived, then stop.
    await sleep(2500);
    const { targetInfos } = await session.cdp.send('Target.getTargets', { filter: [{}] });
    const page = targetInfos.find((info) => info.url.startsWith(origin));
    if (page === undefined) throw new Error('the playground page never opened');
    const { sessionId } = await session.cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    await session.cdp.send('Runtime.enable', {}, sessionId);
    const status = await evaluate(session.cdp, sessionId, 'window.__decoy.status()');
    console.log(`status:     ${JSON.stringify(status)}`);
    await shutdown();
    return;
  }

  // Stay up until interrupted.
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
