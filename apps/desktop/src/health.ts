// Midnight health: whether the indexer and the proof server answer. "Midnight · conectado" only said that the helper
// component had started; with the network down the wallet waited without a deadline and looked like it was syncing.
// The pure rules come first; then the store (with `ping` and the clock injected, so it can be tested with
// `node --test`, like `prefs.ts`) and, at the end, what depends on React.
//
// This changes no operation: it only decides whether one starts. The gate sits before calling `api.*` and never midway.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { t } from './i18n/index.ts';
import type { MidnightHealth } from './bindings/MidnightHealth.ts';
import type { ServerHealth } from './bindings/ServerHealth.ts';
import { STILL_ATTR } from './stillness.ts';

/** What an operation needs to start: `red`, the indexer (syncing the wallet, querying the contract);
 *  `pruebas`, also the proof server (creating addresses, paying, requesting TestToken). */
export type Needs = 'red' | 'pruebas';

/** Without the indexer nothing starts. */
export const noNetworkText = (): string => t().status.health.noNetwork;
/** Without the proof server, anything that generates proofs does not start. */
export const noProofServerText = (): string => t().status.health.noProofServer;
/** Shown under the progress of a running operation when the indexer stops answering: it does not cancel it. */
export const midnightWaitingText = (): string => t().status.health.waiting;

type Reach = Pick<MidnightHealth, 'indexer' | 'proofServer'>;

/** Why an operation cannot start, or `null`. With no data (not checked yet, or the component did not answer the
 *  ping) nothing is blocked: if it really fails, the operation will report its own error. */
export function midnightBlocker(health: Reach | null, needs: Needs): string | null {
  if (!health) return null;
  if (!health.indexer) return noNetworkText();
  if (needs === 'pruebas' && !health.proofServer) return noProofServerText();
  return null;
}

/** The latest result. `failed`: the last ping got no answer (the helper component does not respond). */
export interface Snapshot<T> {
  health: T | null;
  failed: boolean;
}

export type HealthSnapshot = Snapshot<MidnightHealth>;
export type ServerSnapshot = Snapshot<ServerHealth>;

/** The result that can be trusted: if the last ping got no answer, the previous one is no longer valid. */
export function known<T>(s: Snapshot<T>): T | null {
  return s.failed ? null : s.health;
}

/** How often to check again while someone is watching. */
export const HEALTH_EVERY_MS = 30_000;

export interface ProbeEnv<T> {
  ping(): Promise<T>;
  /** Calls `fn` every `ms`; returns how to stop it. */
  every(fn: () => void, ms: number): () => void;
  /** Is the window still (`stillness.ts`)? Then the periodic check is skipped: nobody is looking. */
  still?(): boolean;
  /** Calls `fn` each time the window stops being still (the person returns); returns how to stop it. This way the
   *  status line does not keep stale data for up to 30 s. */
  wake?(fn: () => void): () => void;
  /** Clock in ms for `refresh` (by default `performance.now()`, which does not jump if the machine time changes). */
  now?(): number;
}

export type HealthEnv = ProbeEnv<MidnightHealth>;

export interface ProbeStore<T> {
  /** The latest result. The same object as long as it does not change (it works as a snapshot). */
  get(): Snapshot<T>;
  /** Checks now (if a check is already running, waits for it) and returns the result. Never throws. */
  check(): Promise<Snapshot<T>>;
  /** Checks now only if it makes sense: with someone subscribed (the app unlocked), with no other check running (if
   *  there is one, waits for it) and if the last one finished `maxAgeMs` ago or more. Otherwise returns the last
   *  result. For things repeated at will (opening the status panel): opening and closing quickly does not launch a check each time. */
  refresh(maxAgeMs: number): Promise<Snapshot<T>>;
  /** Notifies every change; returns how to unsubscribe. With the first subscriber it checks and starts repeating every
   *  `HEALTH_EVERY_MS` (except while the window is still); with none, it stops. So it checks on unlock (the main
   *  view mounts) and not while the app is locked. */
  subscribe(listener: () => void): () => void;
}

export type HealthStore = ProbeStore<MidnightHealth>;

/** A store of checks: `same` says whether two results are equal (if so, no notification). */
export function createProbe<T>(env: ProbeEnv<T>, same: (a: T, b: T) => boolean): ProbeStore<T> {
  let current: Snapshot<T> = { health: null, failed: false };
  let inFlight: Promise<Snapshot<T>> | null = null;
  let stop: (() => void) | null = null;
  // When the last check finished (`env.now`), for `refresh`'s age limit.
  let checkedAt: number | null = null;
  const now = env.now ?? (() => performance.now());
  const listeners = new Set<() => void>();
  const equal = (a: T | null, b: T | null) => (a === null || b === null ? a === b : same(a, b));

  const publish = (next: Snapshot<T>) => {
    if (equal(next.health, current.health) && next.failed === current.failed) return;
    current = next;
    listeners.forEach((listener) => listener());
  };

  // One check at a time: whoever asks for another meanwhile waits for that one. So there are never two answers in flight
  // and an old one cannot arrive after a new one and overwrite it.
  const check = () =>
    (inFlight ??= env
      .ping()
      .then(
        (health) => publish({ health, failed: false }),
        // With no answer the last result is kept (the detail still shows it) and the failure is flagged.
        () => publish({ health: current.health, failed: true }),
      )
      .then(() => current)
      .finally(() => {
        checkedAt = now();
        inFlight = null;
      }));

  return {
    get: () => current,
    check,
    refresh(maxAgeMs) {
      if (stop === null) return Promise.resolve(current);
      if (inFlight) return inFlight;
      if (checkedAt !== null && now() - checkedAt < maxAgeMs) return Promise.resolve(current);
      return check();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (stop === null) {
        void check();
        const stopEvery = env.every(() => {
          if (!env.still?.()) void check();
        }, HEALTH_EVERY_MS);
        const stopWake = env.wake?.(() => void check());
        stop = () => {
          stopEvery();
          stopWake?.();
        };
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop !== null) {
          stop();
          stop = null;
        }
      };
    },
  };
}

/** Only what is shown: the ping's versions no longer appear in the status line. */
const sameMidnight = (a: MidnightHealth, b: MidnightHealth) => a.indexer === b.indexer && a.proofServer === b.proofServer;

const sameServer = (a: ServerHealth, b: ServerHealth) =>
  a.mailbox === b.mailbox && a.relayer === b.relayer && a.issuer === b.issuer;

export const createHealth = (env: HealthEnv): HealthStore => createProbe(env, sameMidnight);
export const createServerHealth = (env: ProbeEnv<ServerHealth>): ProbeStore<ServerHealth> =>
  createProbe(env, sameServer);

/** The app's clock (`setInterval`) and whether the window is still (`data-quieto`, from `stillness.ts`). */
const every = (fn: () => void, ms: number) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};
const still = () => document.documentElement.hasAttribute(STILL_ATTR);
/** When `data-quieto` is removed from <html> (the window regains focus or becomes visible). */
const wake = (fn: () => void) => {
  const observer = new MutationObserver(() => {
    if (!still()) fn();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [STILL_ATTR] });
  return () => observer.disconnect();
};

/** The app's Midnight health, via `sidecar_ping`. */
export const health = createHealth({ ping: () => api.sidecarPing(), every, still, wake });

/** Whether the NightMail server answers, via `server_ping`. */
export const serverHealth = createServerHealth({ ping: () => api.serverPing(), every, still, wake });

// --- React

/** The latest result, up to date. While someone is using it, it is checked every `HEALTH_EVERY_MS`. */
export function useHealth(): HealthSnapshot {
  return useSyncExternalStore(health.subscribe, health.get);
}

/** The same for the NightMail server. */
export function useServerHealth(): ServerSnapshot {
  return useSyncExternalStore(serverHealth.subscribe, serverHealth.get);
}

/**
 * A card's gate: `gate(needs)` checks at that moment and says whether it can start. If not, `blocker` carries the
 * reason until the next attempt, and clears itself when what was missing returns. `checking`: a gate check is in
 * progress (button guards look at it to avoid starting twice). `waiting`: the indexer does not answer (for the
 * notice under a running operation).
 */
export function useMidnightGate() {
  const snap = useHealth();
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [checking, setChecking] = useState(false);
  // If the card unmounts during the check (e.g. the app locks), the operation no longer starts.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const gate = useCallback(async (n: Needs): Promise<boolean> => {
    setChecking(true);
    try {
      const after = await health.check();
      if (!alive.current) return false;
      const blocked = midnightBlocker(known(after), n) !== null;
      setNeeds(blocked ? n : null);
      return !blocked;
    } finally {
      setChecking(false);
    }
  }, []);
  return {
    blocker: needs && midnightBlocker(known(snap), needs),
    checking,
    gate,
    waiting: known(snap)?.indexer === false,
  };
}
