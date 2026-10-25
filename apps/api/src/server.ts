import { startServer } from './startup.js';
import { startupErrorCode } from './startup-error.js';

const controller = new AbortController();
const running = startServer(process.env,undefined,controller.signal);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    controller.abort();
    void running.then(server => server.shutdown()).catch(() => { process.exitCode = 1; });
  });
}
try { await running; }
catch (error) {
  // SDK/filesystem/database exceptions may embed secrets. Emit only a diagnostic code.
  console.error(startupErrorCode(error,'WALLET_STARTUP_FAILED'));
  process.exitCode = 1;
}

