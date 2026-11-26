// midnight-sidecar: the only component of the app that uses the Midnight SDK
// (which exists only in TypeScript). Speaks JSON-RPC over stdio with the Rust core.
//
// The stdout guard must load before any dependency.
import { protocolOut } from './stdio.ts';
import { createHandlers, type SidecarState } from './handlers.ts';
import { serve } from './rpc.ts';

const state: SidecarState = { initialized: null };

serve(createHandlers(state), {
  output: protocolOut,
  isDebug: () => state.initialized?.debug === true,
  // Saves and closes the wallet (if open) and exits once stdout has finished writing the last reply.
  onClose: () => {
    const closing = state.closeWallet?.() ?? Promise.resolve();
    closing
      .catch(() => console.error('[sidecar] wallet: could not close cleanly'))
      .finally(() => protocolOut.write('', () => process.exit(0)));
  },
});

console.error('[sidecar] ready');
