// Front screen (no session): welcome, create the seed phrase, show it, restore and unlock. On the left, the fixed
// night panel (also in the light theme; with the night's primitive colours, no nested theme); on the right, the
// form of each step and, in the top corner, the language (Settings only shows after unlocking). Under the logo,
// the rotating slogans. From here too, the other accounts on this device ("Cambiar de cuenta", `Accounts.tsx`).
import { useEffect, useState, type ReactNode } from 'react';
import { accountNameTooLong, hasOtherAccounts, MAX_ACCOUNT_NAME } from '../accounts.ts';
import { api, nextOp } from '../api.ts';
import type { AccountView } from '../bindings/AccountView.ts';
import type { AppStatus } from '../bindings/AppStatus.ts';
import type { RecoveryReport } from '../bindings/RecoveryReport.ts';
import { Campo } from '../components/Campo.tsx';
import { Icon } from '../components/Icon.tsx';
import { Languages } from '../components/Languages.tsx';
import { Logo } from '../components/Logo.tsx';
import { Noche } from '../components/Noche.tsx';
import { Progreso } from '../components/Progreso.tsx';
import { seedWordCount, seedWords } from '../format.ts';
import { t } from '../i18n/index.ts';
import { progressParts } from '../progress.ts';
import { phraseProblem } from '../seedCheck.ts';
import { domSloganClock, rotateSlogans, sloganMemory } from '../slogans.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { AccountChooser } from './Accounts.tsx';
import { ErrorAviso } from './common.tsx';
import { onSubmitWith } from './forms.ts';
import { mismatchText, pairMismatch, pairReady } from './password.ts';
import { RecoveryResult, RecoveryRetry } from './Recovery.tsx';
import { useAction } from './useAction.ts';

interface Props {
  status: AppStatus;
  events: CoreEvents;
  /** Asks for `app_status` again (the session is already open after creating or restoring). */
  onDone: () => void;
  /** The account list is in front ("Cambiar de cuenta", or "Cerrar sesión" in the sidebar). */
  chooser: boolean;
  onChooser: (open: boolean) => void;
}

const PRIMARY = 'button button-large button-solid-norm nm-btn w-full';
const SECONDARY = 'button button-large button-outline-weak nm-btn w-full';
const GHOST = 'button button-large button-ghost-weak nm-btn w-full';

/** The slogans under the logo (`slogans.ts`). All sit in the same cell and only one is visible: so the height is that of the
 *  longest and the night below does not jump when it changes; the fade is in app.css. For the screen reader the rotating ones
 *  are `aria-hidden` (not announced and not changing under the cursor) and in their place there is a single fixed slogan, the first, with no live region. They always rotate, like the front screen's night: see `slogans.ts`. */
function Slogans() {
  const list = t().slogans.list;
  const count = list.length;
  const [index, setIndex] = useState(() => sloganMemory.current(count));
  const [first] = useState(() => sloganMemory.first());
  useEffect(
    () =>
      rotateSlogans(sloganMemory.current(count), count, domSloganClock(), (i) => {
        sloganMemory.remember(i);
        setIndex(i);
      }),
    [count],
  );
  return (
    <div className="nm-portada__lemas">
      <p className="nm-portada__titular">{t().slogans.headline}</p>
      <p className="nm-portada__lema">
        <span className="sr-only">{list[first]}</span>
        <span className="nm-lemas" aria-hidden="true">
          {list.map((slogan, i) => (
            <span key={i} className={i === index ? 'nm-lema keep-motion nm-lema--visible' : 'nm-lema keep-motion'}>
              {slogan}
            </span>
          ))}
        </span>
      </p>
    </div>
  );
}

/** Frame of the whole front screen: the night panel and, on the right, the box with the current step. `paso` tells apart the
 *  steps that share a component (Restaurar: phrase, progress, result) so the box re-enters with its
 *  fade; between different components it already mounts anew. */
function Portada({ paso, children }: { paso?: string; children: ReactNode }) {
  return (
    <div className="nm-raiz">
      <div className="nm-portada">
        <div className="nm-portada__noche">
          <div className="nm-portada__marca">
            <Logo dark />
          </div>
          <Slogans />
          <Noche />
        </div>
        <div className="nm-portada__panel">
          <div key={paso} className="nm-portada__caja">{children}</div>
          <Languages />
        </div>
      </div>
    </div>
  );
}

/** "Volver" to the menu; disabled while something is running (going back would lose what arrives). */
function Back({ onBack, disabled }: { onBack: () => void; disabled: boolean }) {
  return (
    <button type="button" className="button button-small button-ghost-weak nm-btn nm-volver" disabled={disabled} onClick={onBack}>
      <Icon name="arrow-left" className="nm-ic" />
      {t().onboarding.welcome.back}
    </button>
  );
}

function Unlock({ onDone, onAccounts }: { onDone: () => void; onAccounts: () => void }) {
  const [password, setPassword] = useState('');
  const { busy, error, code, run } = useAction();
  const ready = !busy && password !== '';
  async function submit() {
    const ok = await run(async () => {
      await api.unlock(password);
      return true;
    });
    setPassword('');
    if (ok) onDone();
  }
  // A wrong password belongs to the field; any other error (store, files) goes apart and does not mark the field.
  const fieldError = code === 'wrongPassword' ? error : null;
  const s = t().onboarding.welcome.unlock;
  return (
    <Portada>
      <h1 className="nm-portada__titulo">{s.title}</h1>
      <p>{s.text}</p>
      <form className="nm-pila nm-pila--l" onSubmit={onSubmitWith(() => ready && void submit())}>
        <Campo label={s.password} type="password" value={password} onChange={setPassword} error={fieldError} autoFocus />
        <button type="submit" className={PRIMARY} disabled={!ready}>
          {busy ? s.busy : s.submit}
        </button>
      </form>
      <ErrorAviso message={fieldError ? null : error} />
      <button type="button" className={GHOST} disabled={busy} onClick={onAccounts}>
        {t().onboarding.accounts.switchAccount}
      </button>
    </Portada>
  );
}

/** Shows the phrase ONCE; on confirming, it is discarded from state. */
function ShowPhrase({ phrase, onWritten }: { phrase: string; onWritten: () => void }) {
  const s = t().onboarding.welcome.showPhrase;
  return (
    <Portada>
      <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.title}</h1>
      <p>{s.text}</p>
      {/* The words come from the BIP-39 list in English, in both languages: a screen reader reads them in English. */}
      <ol className="nm-semilla nm-semilla--3" lang="en">
        {seedWords(phrase).map((word, i) => (
          <li key={i}>{word}</li>
        ))}
      </ol>
      <p className="nm-portada__pie">{s.note}</p>
      <button type="button" className={PRIMARY} onClick={onWritten}>
        {s.written}
      </button>
    </Portada>
  );
}

interface PairProps {
  /** What goes before the passwords in the same form (the phrase, when restoring). */
  before?: ReactNode;
  /** Label of the first password. */
  label: string;
  /** Something else missing before it can be sent (the empty phrase). */
  blocked?: boolean;
  busy: boolean;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (password: string) => void | Promise<void>;
}

/** A password and its repetition; the button only activates if they match. It empties them on submit. */
function PasswordPair({ before, label, blocked = false, busy, submitLabel, busyLabel, onSubmit }: PairProps) {
  const [one, setOne] = useState('');
  const [two, setTwo] = useState('');
  const mismatch = pairMismatch(one, two);
  const ready = !busy && !blocked && pairReady(one, two);
  async function submit() {
    const p = one;
    setOne('');
    setTwo('');
    await onSubmit(p);
  }
  return (
    <form className="nm-pila nm-pila--l" onSubmit={onSubmitWith(() => ready && void submit())}>
      {before}
      <Campo label={label} type="password" value={one} onChange={setOne} autoFocus={before === undefined} />
      <Campo
        label={t().onboarding.welcome.repeatPassword}
        type="password"
        value={two}
        onChange={setTwo}
        error={mismatch ? mismatchText() : null}
      />
      <button type="submit" className={PRIMARY} disabled={!ready}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}

/** The optional profile name, before the passwords when creating or restoring. */
function ProfileNameField({ value, onChange, autoFocus = false }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const s = t().onboarding.profileName;
  return (
    <Campo
      label={s.label}
      value={value}
      onChange={onChange}
      help={s.help(MAX_ACCOUNT_NAME)}
      error={accountNameTooLong(value) ? s.tooLong(MAX_ACCOUNT_NAME) : null}
      autoFocus={autoFocus}
    />
  );
}

/** Saves the name of the profile just created or restored (its session is open now). Left empty, the core fixes the
 *  number of its automatic name now ("Perfil 4" when there were 3), shown later in the language of each moment. Best
 *  effort: if it fails, the list shows the automatic name with the current numbering, and creating or restoring must
 *  not stop for that. */
async function saveProfileName(name: string): Promise<void> {
  try {
    await api.setAccountName(name);
  } catch {
    // The default name, computed when shown, stays.
  }
}

function Create({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  async function create(password: string) {
    const seed = await run(() => api.createSeed(password));
    if (!seed) return;
    await saveProfileName(name);
    setPhrase(seed.phrase);
  }
  if (phrase !== null) {
    return (
      <ShowPhrase
        phrase={phrase}
        onWritten={() => {
          setPhrase(null);
          onDone();
        }}
      />
    );
  }
  const s = t().onboarding.welcome.create;
  return (
    <Portada>
      <Back onBack={onBack} disabled={busy} />
      <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.title}</h1>
      <p>{s.text}</p>
      <PasswordPair
        before={<ProfileNameField value={name} onChange={setName} autoFocus />}
        label={s.password}
        blocked={accountNameTooLong(name)}
        busy={busy}
        submitLabel={s.submit}
        busyLabel={s.busy}
        onSubmit={create}
      />
      <ErrorAviso message={error} />
    </Portada>
  );
}

function Restore({ events, onBack, onDone }: { events: CoreEvents; onBack: () => void; onDone: () => void }) {
  const [phrase, setPhrase] = useState('');
  const [name, setName] = useState('');
  const [report, setReport] = useState<RecoveryReport | null>(null);
  // The seed was already stored and the session is open, but `recover` failed: the recovery stays pending.
  const [restored, setRestored] = useState(false);
  const [op, setOp] = useState<number | null>(null);
  const { busy, error, code, what, run } = useAction();

  async function submit(password: string) {
    const ok = await run(async () => {
      await api.restoreSeed(phrase, password);
      return true;
    });
    // If it fails (a typo in the phrase) what was typed is kept to correct it; on leaving the screen it is discarded.
    // If it succeeds, out of React as soon as possible (PasswordPair clears the passwords), BEFORE `recover`.
    if (!ok) return;
    setPhrase('');
    await saveProfileName(name);
    const myOp = nextOp();
    setOp(myOp);
    const r = await run(() => api.recover(myOp));
    if (r) setReport(r);
    else setRestored(true);
  }

  const s = t().onboarding.welcome.restore;
  if (report) {
    return (
      <Portada paso="informe">
        <RecoveryResult report={report} onDone={onDone} />
      </Portada>
    );
  }
  if (restored) {
    return (
      <Portada paso="reintento">
        <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.notFinished}</h1>
        <RecoveryRetry message={what} onReport={setReport} />
      </Portada>
    );
  }
  if (op !== null) {
    // `recover` running: the stage is the one the core sends; until the first, the search one (it is what it does).
    const parts = progressParts(events.progress[op] ?? { stage: 'recovering', n: 0 });
    return (
      <Portada paso="progreso">
        <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.recoveringTitle}</h1>
        <p>{s.recoveringText}</p>
        <Progreso stage={parts.stage} note={parts.note ?? undefined} />
      </Portada>
    );
  }
  // An invalid phrase belongs to the phrase field; the rest goes apart. If some word does not exist, which one is said (from
  // what is typed now); otherwise the whole phrase fails (order, word count) and the general notice applies.
  const phraseError = code === 'invalidPhrase' ? (phraseProblem(phrase) ?? error) : null;
  const phraseField = (
    <>
      <Campo label={s.phrase} multiline value={phrase} onChange={setPhrase} help={seedWordCount(phrase)} error={phraseError} autoFocus />
      <ProfileNameField value={name} onChange={setName} />
    </>
  );
  return (
    <Portada paso="frase">
      <Back
        onBack={() => {
          setPhrase('');
          onBack();
        }}
        disabled={busy}
      />
      <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.title}</h1>
      <p>{s.text}</p>
      <PasswordPair
        before={phraseField}
        label={s.password}
        blocked={phrase.trim() === '' || accountNameTooLong(name)}
        busy={busy}
        submitLabel={s.submit}
        busyLabel={s.busy}
        onSubmit={submit}
      />
      <ErrorAviso message={phraseError ? null : error} />
    </Portada>
  );
}

function Menu({ onCreate, onRestore, onAccounts }: { onCreate: () => void; onRestore: () => void; onAccounts: () => void }) {
  // In a new account ("Crear o restaurar otra cuenta"), the way back to the others. Not on a first install.
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.listAccounts().then(
      (list) => !cancelled && setAccounts(list),
      () => !cancelled && setAccounts(null),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const s = t().onboarding.welcome.menu;
  return (
    <Portada>
      <h1 className="nm-portada__titulo">{s.title}</h1>
      <p>{s.text}</p>
      <div className="nm-pila nm-pila--s">
        <button type="button" className={PRIMARY} onClick={onCreate}>
          {s.create}
        </button>
        <button type="button" className={SECONDARY} onClick={onRestore}>
          {s.restore}
        </button>
        {hasOtherAccounts(accounts) && (
          <button type="button" className={GHOST} onClick={onAccounts}>
            {t().onboarding.accounts.backToAccounts}
          </button>
        )}
      </div>
    </Portada>
  );
}

type Mode = 'menu' | 'create' | 'restore';

/** The account list on the front screen. Also for `App` when the account is open in another window. */
export function AccountsScreen({ onBack }: { onBack: () => void }) {
  return (
    <Portada paso="cuentas">
      <AccountChooser onBack={onBack} />
    </Portada>
  );
}

export function Welcome({ status, events, onDone, chooser, onChooser }: Props) {
  const [mode, setMode] = useState<Mode>('menu');
  const back = () => setMode('menu');
  if (chooser) return <AccountsScreen onBack={() => onChooser(false)} />;
  if (status.hasSeed) return <Unlock onDone={onDone} onAccounts={() => onChooser(true)} />;
  if (mode === 'create') return <Create onBack={back} onDone={onDone} />;
  if (mode === 'restore') return <Restore events={events} onBack={back} onDone={onDone} />;
  return <Menu onCreate={() => setMode('create')} onRestore={() => setMode('restore')} onAccounts={() => onChooser(true)} />;
}
