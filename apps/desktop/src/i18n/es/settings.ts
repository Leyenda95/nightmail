// Spanish texts of the `settings` namespace: Settings and the language names.
// This is the shape `en/settings.ts` must repeat.

export default {
  // Name of each language, ALWAYS in its own language (the same in both dictionaries): so whoever does not
  // read the current language can find it. The front screen's selector also uses them, only to read them.
  languageNames: { en: 'English', es: 'Español' },
  // screens/Settings.tsx and screens/settings.ts: the option cards.
  language: {
    legend: 'Idioma',
  },
  layout: {
    legend: 'Disposición',
    three: { title: 'Tres paneles', text: 'La lista y el mensaje, a la vez.' },
    two: { title: 'Dos paneles', text: 'El mensaje se abre en el sitio de la lista. Va mejor en ventanas estrechas.' },
    forced: 'En esta ventana, con este tamaño, no caben tres paneles: se ven dos. Agranda la ventana o baja el tamaño.',
  },
  theme: {
    legend: 'Tema',
    system: { title: 'El del sistema', text: 'Sigue a tu equipo.' },
    light: { title: 'Claro', text: 'Papel cálido.' },
    dark: { title: 'Oscuro', text: 'De noche.' },
    note: 'El correo HTML se ve siempre sobre papel claro, con cualquier tema.',
  },
  size: {
    legend: 'Tamaño de la interfaz',
    /** `percent` is the size "Automático" sets now, already written (`formatPercent`): "Automático (150 %)". */
    automatic: (percent: string): string => `Automático (${percent})`,
    automaticText: 'Se ajusta a la pantalla.',
    standard: 'Tamaño normal.',
    /** `percent` is already written (`formatPercent`): "Un 15 % más grande.". */
    larger: (percent: string): string => `Un ${percent} más grande.`,
    note: 'Agranda toda la app. Por ahora el correo HTML se queda a su tamaño, pero el de solo texto sí crece.',
  },
  // Sound on new mail outside the inbox (the on-screen notice always shows).
  sound: {
    legend: 'Sonido al recibir correo',
    on: { title: 'Activado', text: 'Un sonido breve cuando llega correo.' },
    off: { title: 'Desactivado', text: 'Solo el aviso en pantalla.' },
  },
  // Unread count on the taskbar icon (Windows). Off: no number, but the padlock still shows on locking.
  badgeCount: {
    legend: 'Mostrar el número de correos sin leer en el icono de la barra de tareas',
    on: { title: 'Activado', text: 'El icono de NightMail muestra cuántos correos sin leer hay en la bandeja de entrada.' },
    off: { title: 'Desactivado', text: 'El icono no muestra ningún número. Al bloquear NightMail sigue apareciendo el candado.' },
  },
  // screens/ProfileNameCard.tsx: renaming the open profile (accounts.ts, `set_account_name`).
  profileName: {
    title: 'Nombre del perfil',
    text: (max: number): string =>
      `Se ve en la lista de perfiles antes de desbloquear y se guarda sin cifrar en este dispositivo. Hasta ${max} caracteres. Si lo dejas vacío, se muestra Perfil y su número.`,
    label: 'Nombre',
    save: 'Guardar el nombre',
    saving: 'Guardando…',
    saved: 'Nombre del perfil guardado.',
    tooLong: (max: number): string => `Usa como máximo ${max} caracteres.`,
    failed: 'No se ha podido guardar el nombre del perfil. Vuelve a intentarlo.',
    loadFailed: 'No se ha podido leer el nombre del perfil. Vuelve a abrir Ajustes.',
  },
  // "Contraseña" card (the dialog belongs to onboarding).
  password: {
    title: 'Contraseña',
    text:
      'Protege tu frase semilla en este dispositivo. Si la olvidas, solo podrás volver a entrar con las 24 palabras. ' +
      'Si cambias la contraseña, una copia de seguridad antigua de este dispositivo se sigue abriendo con la ' +
      'contraseña antigua.',
    changed: 'Contraseña cambiada.',
    changedNext: 'La próxima vez, desbloquea NightMail con la nueva.',
    change: 'Cambiar la contraseña',
  },
  // The "Frase semilla" card: opens screens/SeedReveal.tsx.
  seed: {
    title: 'Frase semilla',
    text: 'Muestra tus 24 palabras después de pedirte la contraseña.',
    show: 'Ver la frase semilla',
  },
  version: 'Versión de NightMail',
};
