// Simple state machine (no router): loading, then welcome | main view | incomplete configuration | profile
// open in another window. In front of the welcome or the "already open" screen, the account list.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { badgeLocked } from './badge.ts';
import type { AppStatus } from './bindings/AppStatus.ts';
import { Aviso } from './components/Aviso.tsx';
import { Icon } from './components/Icon.tsx';
import { Languages } from './components/Languages.tsx';
import { LogoSymbol } from './components/Logo.tsx';
import { Luz } from './components/Luz.tsx';
import { describeError, isBadConfig, isBootFailure, isProfileInUse } from './errors.ts';
import { t } from './i18n/index.ts';
import { useLocale } from './i18n/locale.ts';
import { ExitNotice } from './screens/common.tsx';
import { Main } from './screens/Main.tsx';
import { AccountsScreen, Welcome } from './screens/Welcome.tsx';
import { useCoreEvents } from './useCoreEvents.ts';

// The error is stored as is and translated when painting: if the language changes, its text changes.
type Load =
  | { kind: 'loading' }
  | { kind: 'badConfig' }
  | { kind: 'profileInUse' }
  | { kind: 'error'; error: unknown; retriable: boolean }
  | { kind: 'ready'; status: AppStatus };

/** What is painted when the core does not answer: the two causes that retrying does not fix have their own screen. */
function failure(e: unknown): Load {
  if (isBadConfig(e)) return { kind: 'badConfig' };
  if (isProfileInUse(e)) return { kind: 'profileInUse' };
  // The core only fails to answer if it was not mounted at startup (disk or permissions when taking the profile):
  // retrying does not mount it again, the app must be reopened.
  return { kind: 'error', error: e, retriable: !isBootFailure(e) };
}

/** Frame of the startup screens (loading, incomplete configuration, error): the brand symbol and,
 *  centred, whatever applies. The symbol is decoration and picks its version by the theme in view, like the logo.
 *  In the top corner, the language selector, as on the front screen: none of them has Settings. */
function Startup({ children }: { children: ReactNode }) {
  return (
    <div className="nm-raiz">
      <div className="nm-centro">
        <div className="nm-centro__caja">
          <LogoSymbol />
          {children}
        </div>
        <Languages />
      </div>
    </div>
  );
}

export default function App() {
  // Changing the language (Settings) repaints from here, the root: everything below is painted again (there is no `memo`) and
  // each `t()` reads the new language. No restart and no loss of the screens' state.
  useLocale();
  const events = useCoreEvents();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', status: await api.appStatus() });
    } catch (e) {
      setLoad(failure(e));
    }
  }, []);

  // The account list in front of the front screen (or of "ya está abierto"): "Cambiar de perfil", "Elegir otro perfil" or
  // the sidebar's "Cerrar sesión". Also right after starting, when the previous run deleted its open profile.
  const [chooser, setChooser] = useState(false);

  useEffect(() => {
    void (async () => {
      // Asked once, before the first screen: the core forgets it on answering.
      if (await api.takeShowAccounts().catch(() => false)) setChooser(true);
      await refresh();
    })();
  }, [refresh]);

  // "Reintentar" goes through "loading": if it fails again with the same text, it is visible (and announced) that it was tried.
  // Only here, not inside `refresh`: `Welcome` and `locked` call it too, and going through "loading" would unmount them.
  const retry = useCallback(() => {
    setLoad({ kind: 'loading' });
    void refresh();
  }, [refresh]);

  // On locking, the `resume` notice belonged to that session. In the taskbar, the padlock instead of the number
  // (`badge.ts`). With "Cerrar sesión" (`toAccounts`), the account list comes next.
  const { clearResume } = events;
  const locked = useCallback(
    (toAccounts: boolean) => {
      clearResume();
      badgeLocked();
      setChooser(toAccounts);
      void refresh();
    },
    [clearResume, refresh],
  );

  const s = t().onboarding.startup;
  switch (load.kind) {
    case 'loading':
      return (
        <Startup>
          <p className="nm-fila" role="status">
            <Luz mode="trabaja" /> {s.opening}
          </p>
        </Startup>
      );
    case 'badConfig':
      return (
        <Startup>
          <h1 className="nm-centro__titulo">{s.badConfigTitle}</h1>
          <p>{s.badConfigText}</p>
        </Startup>
      );
    case 'profileInUse':
      // No "Reintentar": this window will not take the account even if the other closes. Another account can be opened.
      if (chooser) return <AccountsScreen onBack={() => setChooser(false)} />;
      return (
        <Startup>
          <h1 className="nm-centro__titulo">{s.profileInUseTitle}</h1>
          <p>{s.profileInUseText}</p>
          <button type="button" className="button button-medium button-solid-norm nm-btn" onClick={() => setChooser(true)}>
            {s.chooseOther}
          </button>
        </Startup>
      );
    case 'error':
      // The error is translated when painting (`describeError`): on changing the language here, its text changes.
      return (
        <Startup>
          <h1 className="nm-centro__titulo">{s.failedTitle}</h1>
          <Aviso tone="error">
            <p>{describeError(load.error)}</p>
          </Aviso>
          {load.retriable && (
            <button type="button" className="button button-medium button-solid-norm nm-btn" onClick={retry}>
              <Icon name="arrows-rotate" className="nm-ic" />
              {s.retry}
            </button>
          )}
        </Startup>
      );
    case 'ready':
      // Unlocked, the postponed-exit notice goes in `Main`'s strip; on the front screen, in a strip of its own above.
      if (load.status.unlocked) return <Main events={events} onLocked={locked} />;
      return (
        <div className="nm-cierre">
          {events.exitDeferred && (
            <div className="nm-raiz nm-cierre__aviso">
              <ExitNotice />
            </div>
          )}
          <Welcome status={load.status} events={events} onDone={refresh} chooser={chooser} onChooser={setChooser} />
        </div>
      );
  }
}
