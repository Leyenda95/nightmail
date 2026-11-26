// Settings page: language, layout, theme, interface size, sound and the taskbar number. They apply instantly and are
// stored on this device (`localStorage`); there is no save button nor anything that can fail. At the end, the
// password: changing it goes in a dialog (`PasswordChange`). Then deleting the open profile from this computer, also in
// a dialog (`DeleteProfile.tsx`). Those two and the profile name card are the only things on the page that talk to the
// core. Below everything, the NightMail version.
import { useCallback, useEffect, useState } from 'react';
// The app version is that of its Tauri package: a single place.
import { version } from '../../src-tauri/tauri.conf.json';
import { accountRows, type AccountRow } from '../accounts.ts';
import { api } from '../api.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Icon } from '../components/Icon.tsx';
import { t } from '../i18n/index.ts';
import { classes } from '../pieces.ts';
import { prefs, useAppliedSize, useEffectiveLayout, usePrefs } from '../prefs.ts';
import { DeleteProfileDialog } from './DeleteProfile.tsx';
import { PasswordChange } from './PasswordChange.tsx';
// The profile name card talks to the core too (`set_account_name`): it lives in its own file.
import { ProfileNameCard } from './ProfileNameCard.tsx';
import { badgeCountChoices, languageChoices, layoutChoices, sizeChoices, soundChoices, themeChoices, type Choice } from './settings.ts';

interface GroupProps<T extends string> {
  legend: string;
  name: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  columns?: 'tres';
  note?: string;
}

/** A group of native radios (arrows and Tab for free) with the drawing of each option. */
function Group<T extends string>({ legend, name, choices, value, onChange, columns, note }: GroupProps<T>) {
  return (
    <section className="nm-tarjeta">
      <fieldset className="nm-ajuste">
        <legend className="nm-tarjeta__titulo">{legend}</legend>
        <div className={classes('nm-elecciones', columns === 'tres' && 'nm-elecciones--tres')}>
          {choices.map((c) => (
            <label key={c.value} className={classes('nm-eleccion', c.value === value && 'nm-eleccion--activa')} lang={c.lang}>
              <input type="radio" name={name} checked={c.value === value} onChange={() => onChange(c.value)} />
              <span className="nm-eleccion__cuerpo">
                <span className="nm-eleccion__titulo">
                  {c.title}
                </span>
                {c.text && <span className="nm-eleccion__texto">{c.text}</span>}
              </span>
              {c.art && (
                <span className={c.art} aria-hidden="true">
                  {Array.from({ length: c.boxes }, (_, i) => (
                    <i key={i}></i>
                  ))}
                  {/* The scale goes through CSSOM (the `style` prop), which the CSP allows; no `style=` in the HTML. */}
                  {c.glyph !== undefined && (
                    <span style={c.scale === undefined ? undefined : { fontSize: `${1.25 * c.scale}rem` }}>{c.glyph}</span>
                  )}
                </span>
              )}
            </label>
          ))}
        </div>
        {note && <p className="nm-pista">{note}</p>}
      </fieldset>
    </section>
  );
}

/** "Contraseña" card: opens the dialog and, if it ends well, says so here (on closing, focus returns to the button). */
function PasswordCard() {
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const done = useCallback(() => setChanged(true), []);
  const s = t().settings.password;
  return (
    <section className="nm-tarjeta">
      <h2 className="nm-tarjeta__titulo">{s.title}</h2>
      <p className="nm-suave">{s.text}</p>
      {changed && (
        <Aviso tone="exito">
          <p>
            <strong>{s.changed}</strong> {s.changedNext}
          </p>
        </Aviso>
      )}
      <div>
        <button
          type="button"
          className="button button-medium button-outline-weak nm-btn"
          onClick={() => {
            setChanged(false);
            setOpen(true);
          }}
        >
          {s.change}
        </button>
      </div>
      {open && <PasswordChange onClose={close} onChanged={done} />}
    </section>
  );
}

/** "Eliminar perfil" card: deletes the open profile from this computer (`DeleteProfile.tsx`, with its password); the app
 *  then restarts. Only where there is a profile list (`list_accounts` answers and the open profile is in it). */
function DeleteProfileCard() {
  const [own, setOwn] = useState<AccountRow | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    let cancelled = false;
    api.listAccounts().then(
      (list) => !cancelled && setOwn(accountRows(list).find((row) => row.current) ?? null),
      () => !cancelled && setOwn(null),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (own === null) return null;
  const s = t().onboarding.deleteProfile;
  // Read again on opening: the name may have changed meanwhile (the name card above, or the language).
  function openDialog() {
    api.listAccounts().then(
      (list) => {
        setOwn((before) => accountRows(list).find((row) => row.current) ?? before);
        setOpen(true);
      },
      () => setOpen(true),
    );
  }
  return (
    <section className="nm-tarjeta">
      <h2 className="nm-tarjeta__titulo">{s.cardTitle}</h2>
      <p className="nm-suave">{s.cardText}</p>
      <div>
        <button type="button" className="button button-medium button-outline-weak nm-btn" onClick={openDialog}>
          <Icon name="trash" className="nm-ic" />
          {s.cardButton}
        </button>
      </div>
      {open && <DeleteProfileDialog id={own.id} name={own.name} onClose={close} onDeleted={close} />}
    </section>
  );
}

export function Settings() {
  const { layout, theme, size, locale, sound, badgeCount } = usePrefs();
  const forced = useEffectiveLayout() !== layout;
  const applied = useAppliedSize();
  const s = t().settings;
  return (
    <div className="nm-pagina__estrecha">
      {/* Language first: it changes the whole app instantly, without restarting (App subscribes to the language). */}
      <Group legend={s.language.legend} name="idioma" choices={languageChoices()} value={locale} onChange={prefs.setLocale} />
      <Group
        legend={s.layout.legend}
        name="disposicion"
        choices={layoutChoices()}
        value={layout}
        onChange={prefs.setLayout}
        note={forced ? s.layout.forced : undefined}
      />
      <Group
        legend={s.theme.legend}
        name="tema"
        choices={themeChoices()}
        value={theme}
        onChange={prefs.setTheme}
        columns="tres"
        note={s.theme.note}
      />
      <Group legend={s.size.legend} name="tamano" choices={sizeChoices(applied)} value={size} onChange={prefs.setSize} note={s.size.note} />
      <Group legend={s.sound.legend} name="sonido" choices={soundChoices()} value={sound} onChange={prefs.setSound} />
      <Group
        legend={s.badgeCount.legend}
        name="insignia-numero"
        choices={badgeCountChoices()}
        value={badgeCount}
        onChange={prefs.setBadgeCount}
      />
      <ProfileNameCard />
      <PasswordCard />
      <DeleteProfileCard />
      <p className="nm-pista">
        {s.version} <span className="text-monospace">{version}</span>
      </p>
    </div>
  );
}
