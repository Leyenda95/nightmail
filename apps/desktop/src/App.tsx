// Simple state machine (no router): loading, then welcome | main view | incomplete configuration | profile
// open in another window. In front of the welcome or the "already open" screen, the account list.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { badgeCleared, badgeLocked } from './badge.ts';
import type { AccountView } from './bindings/AccountView.ts';
import type { AppStatus } from './bindings/AppStatus.ts';
import { Aviso } from './components/Aviso.tsx';
import { Icon } from './components/Icon.tsx';
import { Languages } from './components/Languages.tsx';
import { LogoSymbol } from './components/Logo.tsx';
import { Luz } from './components/Luz.tsx';
import { describeError, isBadConfig, isBootFailure, isProfileInUse } from './errors.ts';
import { t } from './i18n/index.ts';
import { useLocale } from './i18n/locale.ts';
import { onProfileOpened, QuietEntry } from './profileSwitch.ts';
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

/** What the next profile's first screen needs, read before it is mounted after a switch, so no loading screen or empty
 *  box is painted in between: its status, whether the profile list goes first, and the list itself when the first
 *  screen will be the profile list or the create or restore menu (`undefined`: not read, `null`: the read failed). */
interface FirstScreen {
  load: Load;
  showAccounts: boolean;
  accounts: AccountView[] | null | undefined;
}

/** Never fails: each read that fails ends where it would on startup (the error screen, no list first, no list).
 *  `chooser`: the profile list goes first anyway (deleting the open profile failed). */
async function readFirstScreen(chooser: boolean): Promise<FirstScreen> {
  const showAccounts = await api.takeShowAccounts().catch(() => false);
  const load = await api.appStatus().then((status): Load => ({ kind: 'ready', status }), failure);
  const menu = load.kind === 'ready' && !load.status.hasSeed && !load.status.unlocked;
  const list = menu || chooser || showAccounts;
  const accounts = list ? await api.listAccounts().catch(() => null) : undefined;
  return { load, showAccounts, accounts };
}

/** The profile list, read before the list screen is shown so it paints with its rows at once. `undefined` if the read
 *  fails: the list screen then reads it itself, as it always did. */
function readChooserList(): Promise<AccountView[] | undefined> {
  return api.listAccounts().catch(() => undefined);
}

/** The whole UI, mounted anew each time another profile opens in this window (`profileSwitch.ts`): every screen and
 *  the core events start empty, as on startup, and the front screen is chosen again below. Its first screen is read
 *  before (`readFirstScreen`), while the previous screen stays in view. The taskbar is cleared too, as on a fresh
 *  start. */
export default function App() {
  const [opened, setOpened] = useState<{
    times: number;
    failedDelete: unknown;
    first: FirstScreen | null;
    quiet: object | null;
  }>({ times: 0, failedDelete: null, first: null, quiet: null });
  useEffect(
    () =>
      onProfileOpened((failedDelete) => {
        void readFirstScreen(failedDelete !== null).then((first) => {
          badgeCleared();
          // The first screen of the next profile appears without its entry fade (`QuietEntry`).
          setOpened((o) => ({ times: o.times + 1, failedDelete, first, quiet: {} }));
        });
      }),
    [],
  );
  return (
    <QuietEntry.Provider value={opened.quiet}>
      <ProfileApp key={opened.times} failedDelete={opened.failedDelete} first={opened.first} />
    </QuietEntry.Provider>
  );
}

/** `failedDelete`: deleting the open profile failed after closing it, and it opened again. The profile list goes first
 *  with the error, until it is left. `first`: the first screen, already read (after a switch); `null` on startup. */
function ProfileApp({ failedDelete, first }: { failedDelete: unknown; first: FirstScreen | null }) {
  // Changing the language (Settings) repaints from here, the root: everything below is painted again (there is no `memo`) and
  // each `t()` reads the new language. No restart and no loss of the screens' state.
  useLocale();
  const events = useCoreEvents();
  const [load, setLoad] = useState<Load>(first?.load ?? { kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', status: await api.appStatus() });
    } catch (e) {
      setLoad(failure(e));
    }
  }, []);

  // The account list in front of the front screen (or of "ya está abierto"): "Cambiar de perfil", "Elegir otro perfil" or
  // the sidebar's "Cerrar sesión". Also right after starting, whenever there is a profile to choose (the core decides,
  // `take_show_accounts`), and after the open profile was deleted.
  const [chooser, setChooserState] = useState(failedDelete !== null || (first?.showAccounts ?? false));
  const [notice, setNotice] = useState<unknown>(failedDelete);
  const setChooser = useCallback((open: boolean) => {
    if (!open) setNotice(null);
    setChooserState(open);
  }, []);
  // The list the profile list screen paints with at once (no frame without its rows): read before showing it.
  const [chooserList, setChooserList] = useState<AccountView[] | undefined>(first?.accounts ?? undefined);
  /** Opening the list from a screen ("Cerrar sesión", the arrows, "Elegir otro perfil"): that screen stays in view until
   *  the list is read, then the list shows with its rows. Closing it is immediate. */
  const showChooser = useCallback(
    async (open: boolean) => {
      if (open) setChooserList(await readChooserList());
      setChooser(open);
    },
    [setChooser],
  );

  // Read on mounting only on startup: after a switch it was read before (`first`). Mounted once per profile.
  const [startup] = useState(first === null);
  useEffect(() => {
    if (!startup) return;
    void (async () => {
      // Asked once, before the first screen: the core forgets it on answering. The list is read first too.
      if (await api.takeShowAccounts().catch(() => false)) await showChooser(true);
      await refresh();
    })();
  }, [startup, refresh, showChooser]);

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
      // The open mailbox stays in view while the list is read (`showChooser`), then the front screen comes.
      void showChooser(toAccounts).then(refresh);
    },
    [clearResume, refresh, showChooser],
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
      if (chooser) return <AccountsScreen onBack={() => setChooser(false)} notice={notice} initial={chooserList} />;
      return (
        <Startup>
          <h1 className="nm-centro__titulo">{s.profileInUseTitle}</h1>
          <p>{s.profileInUseText}</p>
          <button type="button" className="button button-medium button-solid-norm nm-btn" onClick={() => void showChooser(true)}>
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
          <Welcome
            status={load.status}
            events={events}
            onDone={refresh}
            chooser={chooser}
            onChooser={(open) => void showChooser(open)}
            notice={notice}
            menuAccounts={first?.accounts}
            chooserAccounts={chooserList}
          />
        </div>
      );
  }
}
