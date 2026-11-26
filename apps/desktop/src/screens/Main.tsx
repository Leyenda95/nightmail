// Main view after unlocking: sidebar + main panel with one view at a time (inbox, archive, sent, the message being
// written, addresses, plan and wallet, settings) and, above, the notice strip. Navigation is that of `nav.ts`.
//
// All views stay mounted even when not visible (`hidden`): a proof or a payment takes minutes and its progress,
// its "busy" and its error must not be lost by looking at the inbox meanwhile (and the inbox keeps its row).
// Each view is a branch with its own props.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { NO_PENDING_VIEW, nextPendingView, type PendingView } from '../addresses.ts';
import { useTaskbarBadge } from '../badge.ts';
import type { AddressView } from '../bindings/AddressView.ts';
import type { MessageView } from '../bindings/MessageView.ts';
import type { PendingSlot } from '../bindings/PendingSlot.ts';
import type { RecoveryReport } from '../bindings/RecoveryReport.ts';
import type { SentView } from '../bindings/SentView.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Sidebar } from '../components/Sidebar.tsx';
import { afterSend, EMPTY_DRAFT, hasContent, NEW_MESSAGE_ID, pickFrom, type Draft, type ReplySeed } from '../compose.ts';
import { errorParts } from '../errors.ts';
import { mailDomain } from '../format.ts';
import { t } from '../i18n/index.ts';
import { emptyState, headingFor, inAddress, isCapped, unreadCounts, type Unread } from '../inbox.ts';
import { useMailNotice } from '../newMail.ts';
import { droppedKeys, escapeCloses, focusSelector, isList, navigate, noticeFocusSelectors, openHere, panes, START, type List, type Nav, type NavAction, type View } from '../nav.ts';
import { classes } from '../pieces.ts';
import { useEffectiveLayout, usePrefs, type Layout } from '../prefs.ts';
import { listWidthStyle } from '../resize.ts';
import { useServerLine } from '../serviceStatus.ts';
import { mailDownShown } from '../sidebar.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { AddressesSection } from './AddressesSection.tsx';
import { ArchiveView } from './Archive.tsx';
import { Compose, DiscardDialog, type ComposeState } from './Compose.tsx';
import { ExitNotice } from './common.tsx';
import { Inbox, InboxEmpty } from './Inbox.tsx';
import { MailDownNotice, MailDownStatus } from './MailDownNotice.tsx';
import { NewMailNotice, NewMailStatus } from './NewMailNotice.tsx';
import { PendingSection } from './PendingSection.tsx';
import { PlanSection } from './PlanSection.tsx';
import { Reader } from './Reader.tsx';
import { RecoveryDialog, RecoveryRetry } from './Recovery.tsx';
import { ResumeNotices } from './ResumeNotices.tsx';
import { SeedReveal } from './SeedReveal.tsx';
import { SentFolder } from './Sent.tsx';
import { Settings } from './Settings.tsx';
import { useAction } from './useAction.ts';
import { useMessageList, useMessages, type Messages } from './useMessages.ts';
import { WalletSection } from './WalletSection.tsx';

/** Management page: title, intro and content, with its own scroll. */
function Page({ title, intro, hidden, children }: { title: string; intro: string; hidden: boolean; children?: ReactNode }) {
  return (
    <section className="nm-pagina" hidden={hidden}>
      <header className="nm-pagina__cab">
        <h1 className="nm-pagina__titulo">{title}</h1>
        <p>{intro}</p>
      </header>
      <div className="nm-pila nm-pila--l">{children}</div>
    </section>
  );
}

interface InboxViewProps {
  nav: Nav;
  layout: Layout;
  hidden: boolean;
  inbox: Messages;
  /** `null` until AddressesSection loads them. */
  addresses: AddressView[] | null;
  unread: Unread;
  /** The archive as read (`null` until the first read): tells "all archived" from "nothing ever arrived". */
  archived: MessageView[] | null;
  /** The restore has not finished: instead of "first use", "Falta terminar la restauración". */
  restoring: boolean;
  onNav: (action: NavAction) => void;
  onFlags: () => void;
  onLoaded: (ids: number[]) => void;
  onGone: (id: number) => void;
  domain: string | null;
  onReply: (seed: ReplySeed) => void;
}

/** The messages of the chosen address (all without a filter), and reports with `onLoaded` how the list ends up. */
function useShown(messages: MessageView[] | null, addrKey: string | null, onLoaded: (ids: number[]) => void) {
  const shown = useMemo(() => (messages === null ? null : inAddress(messages, addrKey)), [messages, addrKey]);
  useEffect(() => {
    if (shown) onLoaded(shown.map((m) => m.id));
  }, [shown, onLoaded]);
  return shown;
}

/** Inbox: the list and the reader according to the layout (`panes`). With two panels the list is hidden, still mounted. With no
 *  messages (and none open), an empty state at full width in their place. */
function InboxView({ nav, layout, hidden, inbox, addresses, unread, archived, restoring, onNav, onFlags, onLoaded, onGone, domain, onReply }: InboxViewProps) {
  // Only the message opened from the inbox (the archive's is shown by `ArchiveView`).
  const openId = openHere(nav, 'bandeja');
  const show = panes({ openId }, layout);
  const { listWidth } = usePrefs();
  const onOpen = useCallback((id: number) => onNav({ type: 'open', id }), [onNav]);
  const onClose = useCallback(() => onNav({ type: 'close' }), [onNav]);
  // Several archived or deleted at once from the selection: re-read and, if the open one was among them, close it (`nav.ts`).
  const onBulkDone = useCallback(
    (removed: number[], ids: number[]) => {
      onFlags();
      onNav({ type: 'removed', removed, ids, list: 'bandeja' });
    },
    [onFlags, onNav],
  );
  const shown = useShown(inbox.messages, nav.addrKey, onLoaded);
  const empty = shown && openId === null ? emptyState(shown.length, addresses, nav.addrKey, { restoring, read: inbox.messages?.length, archived }) : null;
  if (empty) {
    return (
      <div className="nm-paneles nm-paneles--uno" hidden={hidden}>
        <InboxEmpty state={empty} error={inbox.error} syncing={inbox.syncing} onSync={inbox.syncNow} onPlan={() => onNav({ type: 'go', view: 'plan' })} onNew={() => onNav({ type: 'new' })} />
      </div>
    );
  }
  // Two panels: a single column with the wide list (rows in columns) or the reader in its place.
  return (
    <div className={classes('nm-paneles', layout === 'dos' && 'nm-paneles--dos')} style={listWidthStyle(layout === 'tres', listWidth)} hidden={hidden}>
      <Inbox
        messages={shown}
        heading={headingFor(nav.addrKey, addresses, unread)}
        // With the filter on, saying which address each one reached is redundant.
        addresses={nav.addrKey === null ? addresses : null}
        openId={openId}
        error={inbox.error}
        hidden={!show.list}
        syncing={inbox.syncing}
        onSync={inbox.syncNow}
        onOpen={onOpen}
        resizable={layout === 'tres'}
        scope={`${hidden}|${nav.addrKey ?? ''}`}
        capped={isCapped(inbox.messages?.length)}
        onBulkDone={onBulkDone}
      />
      {show.reader === 'hueco' && (
        <div className="nm-lector">
          <p className="nm-lector__hueco">{t().screensMail.screens.pickMessage}</p>
        </div>
      )}
      {/* key: when the message changes, the reader mounts again (so it does not show the previous one while the new one
          loads, nor Archive/Delete on an id different from the one in view). The reader brings its own panel (`nm-lector`). */}
      {show.reader === 'mensaje' && openId !== null && (
        <Reader key={openId} id={openId} archived={false} domain={domain} onReply={onReply} backToList={layout === 'dos'} onChanged={onFlags} onClose={onClose} onGone={onGone} />
      )}
    </div>
  );
}

/** Esc closes the open message, with focus anywhere in the app except inside the paper (`escapeCloses`). */
function useEscapeToClose(nav: Nav, onNav: (action: NavAction) => void) {
  const { view, openId, openIn } = nav;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!escapeCloses(e, { view, openId, openIn }, document.querySelector('dialog[open]') !== null)) return;
      e.preventDefault();
      onNav({ type: 'close' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, openId, openIn, onNav]);
}

/** Navigation: the state of `nav.ts` with the Settings layout, and the focus each gesture asks for. */
function useNav(layout: Layout) {
  const [nav, setNav] = useState<Nav>(START);
  const onNav = useCallback((action: NavAction) => setNav((n) => navigate(n, action, layout)), [layout]);
  useEffect(() => {
    const selector = focusSelector(nav.focus);
    if (selector) document.querySelector<HTMLElement>(selector)?.focus();
  }, [nav.focus]);
  useEscapeToClose(nav, onNav);
  return [nav, onNav] as const;
}

/** Focus, once the view in front has been painted, on the first of `targets` that accepts it (a hidden one does not). */
function focusSoon(targets: readonly (() => HTMLElement | null)[]) {
  requestAnimationFrame(() => {
    for (const find of targets) {
      const element = find();
      element?.focus();
      if (element && document.activeElement === element) return;
    }
  });
}

/**
 * The message being written (`Compose`) and what follows sending it: "Nuevo mensaje" and "Responder" open it (if
 * another one with something written is open, they ask before discarding it), discarding returns to where it was
 * opened from, and sending returns to the list with a discreet "Mensaje enviado." or, if it did not go out, opens it in
 * "Enviados" (it says why and offers to retry).
 */
function useCompose(nav: Nav, onNav: (action: NavAction) => void, addresses: AddressView[] | null) {
  const [compose, setCompose] = useState<ComposeState | null>(null);
  // Another message waiting for the one being written to be discarded (`DiscardDialog`).
  const [waiting, setWaiting] = useState<ComposeState | null>(null);
  const nextKey = useRef(0);
  const [sentOpen, setSentOpen] = useState<number | null>(null);
  // Rises when something was sent: "Enviados" is re-read.
  const [sentTick, setSentTick] = useState(0);
  // "Mensaje enviado.", over the list the app returned to. It leaves as soon as another view is shown.
  const [notice, setNotice] = useState<View | null>(null);
  if (notice !== null && nav.view !== notice) setNotice(null);

  const fresh = (draft: Draft, reply: boolean): ComposeState => ({
    draft,
    seed: draft,
    reply,
    returnTo: nav.view === 'redactar' ? (compose?.returnTo ?? 'bandeja') : nav.view,
    key: ++nextKey.current,
  });
  const show = (next: ComposeState) => {
    setCompose(next);
    setNotice(null);
    onNav({ type: 'go', view: 'redactar' });
  };
  const written = compose !== null && hasContent(compose.draft, compose.seed);

  /** "Nuevo mensaje": back to the message being written, if it has anything; otherwise a new one from the inbox in view. */
  const onNew = () => {
    if (written) onNav({ type: 'go', view: 'redactar' });
    else show(fresh({ ...EMPTY_DRAFT, fromKey: pickFrom(addresses ?? [], nav.addrKey) }, false));
  };
  const onReply = (seed: ReplySeed) => {
    const next = fresh({ fromKey: pickFrom(addresses ?? [], seed.addrKey), to: seed.to, subject: seed.subject, body: '' }, true);
    if (written) setWaiting(next);
    else show(next);
  };
  const onChange = useCallback((draft: Draft) => setCompose((c) => c && { ...c, draft }), []);

  /** Closes the form and shows `view` (the inbox keeps the address filter it had). */
  const leave = (view: View) => {
    setCompose(null);
    onNav(view === 'bandeja' && nav.addrKey !== null ? { type: 'filter', addrKey: nav.addrKey } : { type: 'go', view });
  };
  const onDiscard = () => {
    if (!compose) return;
    leave(compose.returnTo);
    // Focus returns to what opened it: "Responder" in the reader in view, or "Nuevo mensaje".
    const reply = () => (compose.reply ? document.querySelector<HTMLElement>('.nm-paneles:not([hidden]) [data-nm-responder]') : null);
    focusSoon([reply, () => document.getElementById(NEW_MESSAGE_ID)]);
  };
  const onSent = (view: SentView) => {
    setSentTick((n) => n + 1);
    if (afterSend(view.status) === 'sent') {
      setCompose(null);
      setSentOpen(view.id);
      onNav({ type: 'go', view: 'enviados' });
      return;
    }
    const list: List = compose && isList(compose.returnTo) ? compose.returnTo : 'bandeja';
    leave(list);
    setNotice(list);
    focusSoon(noticeFocusSelectors(list).map((selector) => () => document.querySelector<HTMLElement>(selector)));
  };

  const dialog = waiting && (
    <DiscardDialog
      replace
      onYes={() => {
        setWaiting(null);
        show(waiting);
      }}
      onNo={() => setWaiting(null)}
    />
  );
  return { compose, onNew, onReply, onChange, onDiscard, onSent, dialog, sentOpen, setSentOpen, sentTick, notice, dismissNotice: () => setNotice(null) };
}

export function Main({ events, onLocked }: { events: CoreEvents; onLocked: (toAccounts: boolean) => void }) {
  // The chosen layout, unless this window (at this font size) cannot fit three panels.
  const layout = useEffectiveLayout();
  const [nav, onNav] = useNav(layout);
  const [flagsTick, setFlagsTick] = useState(0);
  const [planTick, setPlanTick] = useState(0);
  // Only rises when the plan is paid: the wallet is re-read after a payment, not on creating or naming an address (each
  // read syncs the wallet with the bono lock taken). It is also re-read when the background DUST registration finishes
  // (`events.walletTick`).
  const [walletTick, setWalletTick] = useState(0);
  // The sidebar's addresses: AddressesSection (always mounted) loads them and reports with `onLoaded`, also after creating.
  // `null` until the first load: the inbox does not show "first use" before knowing whether there are any.
  const [addresses, setAddresses] = useState<AddressView[] | null>(null);
  const composer = useCompose(nav, onNav, addresses);
  // The inbox messages: the list and the sidebar's unread counts (light and counter) come from the same read.
  const inbox = useMessages(events.syncTick + flagsTick);
  const unread = useMemo(() => unreadCounts(inbox.messages ?? []), [inbox.messages]);
  useTaskbarBadge(unread.total);
  // The archive: re-read with the same trigger as the inbox (archiving in one changes the other).
  const archive = useMessageList(events.syncTick + flagsTick, true);
  const [seedOpen, setSeedOpen] = useState(false);
  const { busy: locking, error, run } = useAction();
  const [late, setLate] = useState<RecoveryReport | null>(null);
  const [lateDone, setLateDone] = useState(false);
  // Plan and Wallet share the payment wallet (and the bono lock): while one works, the other waits.
  const [planBusy, setPlanBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  // The half-done addresses (how many and which, for the menu label and the `resume` notice): read by
  // PendingSection, always mounted.
  const [pending, setPending] = useState<PendingView>(NO_PENDING_VIEW);
  // The list as shown: after archiving or deleting, focus goes to the row that takes its place.
  const shownIds = useRef<number[]>([]);
  // The server line, one for the sidebar and for the mail notice (they turn red and return together). It is
  // counted here with any view open: on returning to the inbox, the notice already knows whether it applies.
  const serverNow = useServerLine();

  const openSeed = useCallback(() => setSeedOpen(true), []);
  const closeSeed = useCallback(() => setSeedOpen(false), []);
  const closeLate = useCallback(() => setLateDone(true), []);
  const onFlags = useCallback(() => setFlagsTick((t) => t + 1), []);
  const onPlanChanged = useCallback(() => setPlanTick((t) => t + 1), []);
  // With the same count, the same state: each list reload does not repaint the whole screen.
  const onPendingList = useCallback(
    (list: readonly PendingSlot[] | null) => setPending((prev) => nextPendingView(prev, list)),
    [],
  );
  const onPaid = useCallback(() => {
    setPlanTick((t) => t + 1);
    setWalletTick((t) => t + 1);
  }, []);
  const onLoaded = useCallback((ids: number[]) => {
    shownIds.current = ids;
  }, []);
  // The address of the open message, from the last read of the inbox or archive that carries it. If it stops being
  // there (its address was abandoned and the new read no longer carries it), the previous one is kept: it is the one needed.
  // When the message closes (by any route) it is cleared: it is only read in "dropped", which looks at the open message.
  const openAddr = useRef<string | null>(null);
  useEffect(() => {
    if (nav.openId === null) {
      openAddr.current = null;
      return;
    }
    const found = inbox.messages?.find((m) => m.id === nav.openId) ?? archive.messages?.find((m) => m.id === nav.openId);
    if (found) openAddr.current = found.addrKey;
  }, [nav.openId, inbox.messages, archive.messages]);
  // `onNav` changes with the layout: it is read from a ref so `onAddresses` does not change (AddressesSection would re-read
  // the list and clear its error on resizing the window or changing Settings).
  const onNavNow = useRef(onNav);
  useEffect(() => {
    onNavNow.current = onNav;
  }, [onNav]);
  // Rises each time an address enters or leaves (never falls): the sidebar re-reads the quota.
  const [addressesTick, setAddressesTick] = useState(0);
  // An address that is no longer there (abandoned): its filter is removed and its open message is closed (`dropped`).
  const known = useRef<AddressView[]>([]);
  const onAddresses = useCallback((list: AddressView[]) => {
    const gone = droppedKeys(known.current, list);
    for (const addrKey of gone) onNavNow.current({ type: 'dropped', addrKey, openAddr: openAddr.current });
    const added = droppedKeys(list, known.current);
    if (gone.length > 0 || added.length > 0) setAddressesTick((t) => t + 1);
    known.current = list;
    setAddresses(list);
  }, []);
  const onGone = useCallback((id: number) => onNav({ type: 'gone', id, ids: shownIds.current }), [onNav]);

  // "Bloquear" has no `disabled` (the button would lose focus): the guard is here, in a ref and not in `locking`,
  // which in a stale closure (two presses before repainting) would still be false.
  // "Cerrar sesión" (`toAccounts`) is the same lock and then shows the account list. With a payment in flight the core
  // refuses (`sessionBusy`) and its notice goes in the strip, as with "Bloquear".
  const lockingNow = useRef(false);
  async function lock(toAccounts: boolean) {
    if (lockingNow.current) return;
    lockingNow.current = true;
    try {
      const ok = await run(async () => {
        await api.lock();
        return true;
      });
      if (ok) onLocked(toAccounts);
    } finally {
      lockingNow.current = false;
    }
  }

  const view = nav.view;
  // New mail while looking at something else: notice and sound (`newMail.ts`).
  const newMail = useMailNotice(events.mailArrived, view === 'bandeja');
  const goToInbox = useCallback(() => onNav({ type: 'go', view: 'bandeja' }), [onNav]);
  const recovered = late ?? events.recovered;
  const mailDown = mailDownShown(isList(view), serverNow);
  // "@domain" for the missing name of a mailbox in "En proceso" (the same as in "Tus direcciones").
  const domain = mailDomain(addresses ?? []);
  const pendingSuffix = domain === null ? undefined : `@${domain}`;
  const words = t().screensMail.compose;
  return (
    <div className="nm-raiz">
      <div className="nm-app">
        <Sidebar
          nav={nav}
          addresses={addresses ?? []}
          unread={unread}
          // Sum of counters that only grow: it changes if any of them changes.
          planKey={planTick + events.syncTick + addressesTick}
          onNav={onNav}
          onCompose={composer.onNew}
          onSeed={openSeed}
          onLock={() => void lock(false)}
          onLogOut={() => void lock(true)}
          locking={locking}
          syncing={inbox.syncing}
          onSync={inbox.syncNow}
          pending={pending.count}
          serverNow={serverNow}
        />
        <main className="nm-main">
          {/* What the mail notice announces: outside the strip (which, empty, is not visible) and always mounted. */}
          <MailDownStatus shown={mailDown} />
          <NewMailStatus count={newMail.count} />
          {/* Strip of global notices, edge to edge over the panels. Empty, it is not visible. */}
          <div className="nm-main__avisos">
            {error && (
              <Aviso tone="error" strip>
                <p>{error}</p>
              </Aviso>
            )}
            {/* After sending: discreet, over the list it returned to, until another view is shown. */}
            {composer.notice !== null && (
              <Aviso
                tone="exito"
                strip
                actions={
                  <>
                    <button type="button" className="button button-small button-outline-weak nm-btn" onClick={() => onNav({ type: 'go', view: 'enviados' })}>
                      {words.viewSent}
                    </button>
                    <button type="button" className="button button-small button-ghost-weak nm-btn" onClick={composer.dismissNotice}>
                      {words.dismiss}
                    </button>
                  </>
                }
              >
                <p>{words.sent}</p>
              </Aviso>
            )}
            {/* Once over the list and the reader (inbox and archive), also with the empty inbox. */}
            {isList(view) && mailDown && <MailDownNotice list={view} />}
            {newMail.count > 0 && <NewMailNotice count={newMail.count} onGo={goToInbox} onDismiss={newMail.dismiss} onHold={newMail.hold} />}
            {events.exitDeferred && <ExitNotice />}
            <ResumeNotices events={events} pending={pending.slots} />
            {events.recoverFailed && !late && <RecoveryRetry strip message={errorParts(events.recoverFailed).what} onReport={setLate} />}
          </div>
          <InboxView
            nav={nav}
            layout={layout}
            hidden={view !== 'bandeja'}
            inbox={inbox}
            addresses={addresses}
            unread={unread}
            archived={archive.messages}
            restoring={events.recoverFailed !== null && !late}
            onNav={onNav}
            onFlags={onFlags}
            onLoaded={onLoaded}
            onGone={onGone}
            domain={domain}
            onReply={composer.onReply}
          />
          <ArchiveView
            nav={nav}
            layout={layout}
            hidden={view !== 'archivo'}
            archive={archive}
            syncError={inbox.syncError}
            syncing={inbox.syncing}
            onSync={inbox.syncNow}
            addresses={addresses}
            onNav={onNav}
            onFlags={onFlags}
            domain={domain}
            onReply={composer.onReply}
          />
          <SentFolder
            layout={layout}
            hidden={view !== 'enviados'}
            reloadKey={composer.sentTick + events.syncTick}
            openId={composer.sentOpen}
            onOpen={composer.setSentOpen}
          />
          {composer.compose && (
            <Compose
              key={composer.compose.key}
              state={composer.compose}
              addresses={addresses}
              domain={domain}
              hidden={view !== 'redactar'}
              onChange={composer.onChange}
              onSent={composer.onSent}
              onDiscard={composer.onDiscard}
              onAddresses={() => onNav({ type: 'go', view: 'direcciones' })}
            />
          )}
          <Page title={t().screensMail.screens.addresses} intro={t().screensMail.screens.addressesIntro} hidden={view !== 'direcciones'}>
            <AddressesSection
              events={events}
              onLoaded={onAddresses}
              reloadKey={planTick + events.syncTick}
              onNav={onNav}
              onChanged={onPlanChanged}
              pending={
                <PendingSection
                  events={events}
                  reloadKey={planTick + events.syncTick}
                  suffix={pendingSuffix}
                  onChanged={onPlanChanged}
                  onList={onPendingList}
                />
              }
            />
          </Page>
          <Page title={t().screensMail.screens.plan} intro={t().screensMail.screens.planIntro} hidden={view !== 'plan'}>
            <div className="nm-cols">
              <div className="nm-col">
                <PlanSection events={events} onChanged={onPaid} reloadKey={planTick + events.syncTick} otherBusy={walletBusy} onBusy={setPlanBusy} />
              </div>
              <div className="nm-col">
                <WalletSection events={events} reloadKey={walletTick + events.walletTick} hidden={view !== 'plan'} otherBusy={planBusy} onBusy={setWalletBusy} />
              </div>
            </div>
          </Page>
          <Page title={t().screensMail.screens.settings} intro={t().screensMail.screens.settingsIntro} hidden={view !== 'ajustes'}>
            <Settings />
          </Page>
        </main>
      </div>
      {/* Dialogs: viewing the phrase (unmounts on closing, and the phrase with it) and the late result of a restore. */}
      {seedOpen && <SeedReveal onClose={closeSeed} />}
      {recovered && !lateDone && <RecoveryDialog report={recovered} onDone={closeLate} />}
      {composer.dialog}
    </div>
  );
}
