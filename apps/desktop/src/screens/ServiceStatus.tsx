// "Estado del servicio" line at the foot of the sidebar: a summary of Midnight (whether the network, the indexer and the
// proof server respond) and of the NightMail server (whether mail, bono issuing and address creation, which is the
// relayer, answer). Each part according to its last check (`health.ts`, every 30 s and on opening the panel) and, on
// pressing the line, a panel opening upwards with the detail of both and "Comprobar conexión": a coloured dot only in
// the summary and in each part's title (its word goes to the screen reader, once), and in each row its name and a
// word ("responde", "no responde", "comprobando", "sin comprobar"). Nothing on hover and no sentences.
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { SidecarStatus } from '../bindings/SidecarStatus.ts';
import { Icon } from '../components/Icon.tsx';
import { health, useHealth, useServerHealth, type HealthSnapshot, type ServerSnapshot } from '../health.ts';
import { checkAll, checkAllOnOpen, useOverdue } from '../serviceStatus.ts';
import { t } from '../i18n/index.ts';
import { midnightLine, partLine, serverParts, serviceLine, type StatusLineView } from '../sidebar.ts';
import { usePopup } from '../usePopup.ts';

const PANEL_ID = 'servicio-detalle';

/** The coloured dot of a state (green, yellow, red or grey), in the summary and the titles. It is only seen: the state's
 *  word is carried by whoever uses it, as text for the screen reader (`sr-only`). No `title`: the reader would
 *  read it twice. */
function Dot({ line }: { line: StatusLineView }) {
  return <span className={`nm-punto nm-punto--${line.tone}`} aria-hidden="true" />;
}

/** The title of a panel part, with the dot of its own state. */
function PartTitle({ label, line }: { label: string; line: StatusLineView }) {
  return (
    <h2 className="nm-estado-panel__titulo">
      <span>
        {label}
        <span className="sr-only">, {line.text}</span>
      </span>
      <Dot line={line} />
    </h2>
  );
}

/** A detail row: the name and, on the right, the word saying whether it responds. */
function PartRow({ label, ok, pending }: { label: string; ok: boolean | null; pending: boolean }) {
  const line = partLine(ok, pending);
  return (
    <div>
      <dt>{label}</dt>
      <dd className={`nm-estado-panel__palabra nm-estado-panel__palabra--${line.tone}`}>{line.text}</dd>
    </div>
  );
}

function MidnightDetail({ status, snap, line }: { status: SidecarStatus | null; snap: HealthSnapshot; line: StatusLineView }) {
  // What a sentence under the detail used to say now goes, for the screen reader, in the title's word.
  const text =
    status?.state === 'down'
      ? t().screensPlan.service.down(status.failures)
      : snap.failed && line.tone === 'caido'
        ? t().screensPlan.service.noConnection
        : line.text;
  const h = snap.failed ? null : snap.health;
  const pending = !snap.failed && snap.health === null;
  return (
    <section className="nm-estado-panel__parte">
      <PartTitle label="Midnight" line={{ ...line, text }} />
      <dl className="nm-estado-panel__filas">
        <PartRow label={t().screensPlan.service.midnightNetwork} ok={h ? h.indexer : null} pending={pending} />
        <PartRow label="Proof server" ok={h ? h.proofServer : null} pending={pending} />
      </dl>
    </section>
  );
}

function ServerDetail({ snap, line }: { snap: ServerSnapshot; line: StatusLineView }) {
  const h = snap.failed ? null : snap.health;
  const pending = !snap.failed && snap.health === null;
  return (
    <section className="nm-estado-panel__parte">
      <PartTitle label={t().screensPlan.service.server} line={line} />
      <dl className="nm-estado-panel__filas">
        {serverParts().map((p) => (
          <PartRow key={p.key} label={p.label} ok={h ? h[p.key] : null} pending={pending} />
        ))}
      </dl>
    </section>
  );
}

/** The state of Midnight's helper component (starting, ready, down...), every 2 s. */
function useSidecarStatus(): SidecarStatus | null {
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  useEffect(() => {
    const refresh = () => api.sidecarStatus().then(setStatus, () => setStatus(null));
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, []);

  // As soon as the component is ready (on startup or after restarting), it is checked without waiting for the 30 s.
  const ready = status?.state === 'ready';
  useEffect(() => {
    if (ready) void health.check();
  }, [ready]);
  return status;
}

/** The line with its detail panel. `serverNow`: the server line already with its deadline (`useServerLine`), computed in
 *  `Main` and shared with the list's mail notice. */
export function ServiceStatus({ serverNow }: { serverNow: StatusLineView }) {
  const status = useSidecarStatus();
  const midnight = useHealth();
  const server = useServerHealth();
  const midnightNow = useOverdue(midnightLine(status, midnight));
  const line = serviceLine(midnightNow, serverNow);
  const [checking, setChecking] = useState(false);
  // The panel closes on pressing outside the box or with Esc (`usePopup`).
  const { open, setOpen, box, toggle } = usePopup(PANEL_ID);

  async function ping() {
    // No `disabled` on the button: a focused control that gets disabled loses focus.
    if (checking) return;
    setChecking(true);
    try {
      await checkAll();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="nm-estado-caja" ref={box}>
      {open && (
        <div className="nm-estado-panel" id={PANEL_ID}>
          <MidnightDetail status={status} snap={midnight} line={midnightNow} />
          <ServerDetail snap={server} line={serverNow} />
          <button
            type="button"
            className="button button-small button-outline-weak nm-btn"
            aria-busy={checking || undefined}
            aria-disabled={checking || undefined}
            onClick={ping}
          >
            <Icon name={checking ? 'espera' : 'arrows-rotate'} className="nm-ic" />
            {checking ? t().screensPlan.checking : t().screensPlan.service.checkConnection}
          </button>
        </div>
      )}
      <button
        ref={toggle}
        type="button"
        className="nm-estado"
        aria-expanded={open}
        aria-controls={open ? PANEL_ID : undefined}
        onClick={() => {
          // On opening, the state is brought up to date without waiting for the 30 s check. The result arrives through the store
          // (`useHealth`), not here: there is nothing to keep after the `await` nor to overwrite if it closes first.
          if (!open) void checkAllOnOpen();
          setOpen(!open);
        }}
      >
        <Dot line={line} />
        <span>
          {t().screensPlan.service.title}
          <span className="sr-only">, {line.text}</span>
        </span>
        <Icon name={open ? 'chevron-down' : 'chevron-up'} className="nm-ic" />
      </button>
    </div>
  );
}
