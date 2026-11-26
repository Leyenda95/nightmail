// Spanish texts of the `onboarding` namespace: front screen, recovery phrase, password, App.tsx and the front screen's language selector.
// This is the shape `en/onboarding.ts` must repeat.
//
// The language names and the word "Idioma" of the front screen's selector belong to `settings` (they are read from there). The
// "Reintentar ahora" button of the pending notice is `status.notices.retryNow`.

const PASSWORD = 'Contraseña';
const CANCEL = 'Cancelar';
const CREATE_PHRASE = 'Crear mi frase semilla';
const RETRYING = 'Reintentando…';
const COPY_PHRASE = 'Copiar';

export default {
  // App.tsx: startup screens.
  startup: {
    opening: 'Abriendo NightMail…',
    badConfigTitle: 'Configuración incompleta',
    badConfigText:
      'Faltan ajustes del núcleo (por ejemplo, la dirección del servidor). Revisa la configuración y vuelve a abrir la app.',
    profileInUseTitle: 'NightMail ya está abierto',
    profileInUseText: 'Este perfil ya está abierto en otra ventana de NightMail. Usa esa ventana o elige otro perfil.',
    chooseOther: 'Elegir otro perfil',
    failedTitle: 'No se ha podido abrir NightMail',
    retry: 'Reintentar',
  },
  // screens/Welcome.tsx
  welcome: {
    back: 'Volver',
    menu: {
      title: 'Aquí no hay cuentas ni registros.',
      text:
        'Tu identidad son 24 palabras que solo viven en este dispositivo. Con ellas creas direcciones que nadie puede ' +
        'relacionar entre sí. Tampoco nosotros.',
      create: CREATE_PHRASE,
      restore: 'Ya tengo una frase',
    },
    unlock: {
      title: 'Desbloquea NightMail',
      text: 'Escribe tu contraseña para abrir NightMail en este dispositivo.',
      password: PASSWORD,
      submit: 'Desbloquear',
      busy: 'Desbloqueando…',
    },
    create: {
      title: 'Elige una contraseña',
      text:
        'Protege tu frase semilla en este dispositivo. Nadie más la conoce: si la olvidas, solo podrás volver a entrar ' +
        'con las 24 palabras.',
      password: PASSWORD,
      submit: CREATE_PHRASE,
      busy: 'Creando tu frase semilla…',
    },
    showPhrase: {
      title: 'Tu frase semilla',
      text:
        'Guárdala en un lugar seguro, sin conexión. Quien tenga estas 24 palabras puede acceder a tu perfil. Nosotros no ' +
        'podremos recuperarla por ti.',
      copy: COPY_PHRASE,
      written: 'La he apuntado',
    },
    restore: {
      title: 'Restaurar desde tu frase',
      text: 'Escribe tus 24 palabras en orden, separadas por espacios. No salen de este dispositivo.',
      phrase: 'Frase semilla',
      password: 'Contraseña para este dispositivo',
      submit: 'Restaurar',
      busy: 'Restaurando…',
      notFinished: 'La restauración no ha terminado',
      recoveringTitle: 'Recuperando tus direcciones',
      recoveringText:
        'Buscamos en Midnight los bonos y las direcciones que salen de tu frase semilla. Puede tardar, así que no ' +
        'cierres la app.',
    },
    repeatPassword: 'Repite la contraseña',
  },
  // screens/Accounts.tsx and accounts.ts: several accounts on one device ("Elige un perfil").
  accounts: {
    title: 'Elige un perfil',
    text: 'Estos son los perfiles guardados en este dispositivo. Cada uno se abre con su propia contraseña.',
    name: (n: number): string => `Perfil ${n}`,
    // `day`: "18 nov 2026" (`formatDay`).
    created: (day: string): string => `Creado el ${day}`,
    recentlyUsed: 'Usado recientemente',
    // The "+" button of the list and the title of the screen it opens.
    newProfile: 'Nuevo perfil',
    newProfileText: 'Elige la red que usará este perfil.',
    network: 'Red',
    networks: {
      local: { title: 'Local', text: 'Una red de pruebas en este ordenador.' },
      preprod: { title: 'Preprod', text: 'La red de pruebas de Midnight.' },
      mainnet: { title: 'Mainnet', text: 'La red principal de Midnight.' },
    },
    soon: 'Pronto',
    continue: 'Continuar',
    backToAccounts: 'Volver a mis perfiles',
    openingTitle: 'Abriendo el perfil…',
    openingText: 'NightMail se cerrará y se abrirá de nuevo con el perfil elegido.',
    failed: 'No se ha podido cambiar de perfil. Vuelve a intentarlo.',
    loadFailed: 'No se ha podido leer la lista de perfiles.',
    retry: 'Reintentar',
  },
  // screens/SeedReveal.tsx: the "Frase semilla" card of Settings.
  seedReveal: {
    askTitle: 'Ver tu frase semilla',
    askText: 'Escribe tu contraseña. Antes, comprueba que nadie más ve la pantalla.',
    password: PASSWORD,
    empty: 'Escribe tu contraseña.',
    cancel: CANCEL,
    show: 'Mostrar',
    busy: 'Comprobando…',
    title: 'Tu frase semilla',
    hint:
      'Apúntala en papel y guárdala en un lugar seguro, sin conexión. No la compartas con nadie: quien tenga estas 24 ' +
      'palabras controla tu perfil.',
    copy: COPY_PHRASE,
    close: 'Cerrar',
  },
  // screens/Recovery.tsx: result of the restore and its retry.
  recovery: {
    intro: 'Esto es lo que hemos recuperado de Midnight:',
    // `what`: the slot kind already written in this language (`slotKindName`, from `mail.slotKind`): "buzón", "alias".
    missingName: (what: string): string => `Falta el nombre de un ${what}`,
    missingNameText: (what: string): string =>
      `No hemos podido leer el nombre del ${what}. Escríbelo tal como lo elegiste y comprobaremos que coincide.`,
    nameLabel: (what: string): string => `Nombre del ${what}`,
    later: 'También puedes poner el nombre más tarde, en «Direcciones».',
    doneTitle: 'Restauración terminada',
    continue: 'Continuar',
    retry: 'Reintentar restauración',
    retrying: RETRYING,
    notCompleted: 'La restauración no se ha completado.',
    safe:
      'Tu frase semilla ya está guardada y cifrada en este dispositivo. Hasta que termine la restauración no puedes ' +
      'usar el plan ni las direcciones.',
  },
  // screens/ResumeNotices.tsx
  resume: {
    retrying: RETRYING,
    meanwhile: 'Mientras tanto, puedes seguir usando la app.',
  },
  // screens/PasswordChange.tsx and screens/password.ts (Settings; the pair's rules also apply on the front screen).
  password: {
    title: 'Cambiar la contraseña',
    text: 'Después, desbloquea NightMail con la contraseña nueva.',
    current: 'Contraseña actual',
    next: 'Contraseña nueva',
    repeat: 'Repite la contraseña nueva',
    cancel: CANCEL,
    submit: 'Cambiar la contraseña',
    busy: 'Cambiando…',
    mismatch: 'Las contraseñas no coinciden.',
    typeCurrent: 'Escribe tu contraseña actual.',
    typeNext: 'Escribe la contraseña nueva.',
    repeatNext: 'Repite la contraseña nueva.',
    same: 'La contraseña nueva es igual a la actual.',
    notChanged: 'No se ha cambiado la contraseña.',
  },
  // screens/Welcome.tsx: the optional profile name when creating or restoring (accounts.ts, `set_account_name`).
  profileName: {
    label: 'Nombre del perfil (opcional)',
    tooLong: (max: number): string => `Usa como máximo ${max} caracteres.`,
  },
  // screens/DeleteProfile.tsx: deleting a profile from this computer (the trash can of each box in the profile list
  // and the Settings card). Only this computer's files: nothing on the chain.
  deleteProfile: {
    // `name`: the profile's name as the list shows it ("Perfil 2" or the one chosen). Trash can's accessible name.
    trashLabel: (name: string): string => `Eliminar ${name} de este ordenador`,
    title: 'Eliminar perfil de este ordenador',
    // `name`: as in `trashLabel`.
    which: (name: string): string => `Perfil: ${name}`,
    device: 'Se borrarán de este ordenador las claves de este perfil, su correo guardado aquí y su nombre.',
    chain:
      'En Midnight no se borra nada. Las direcciones que registraste siguen existiendo y puedes recuperarlas con las 24 palabras.',
    words: 'Si no tienes apuntadas las 24 palabras de este perfil, el perfil y su saldo se perderán para siempre.',
    password: 'Contraseña de este perfil',
    empty: 'Escribe la contraseña de este perfil.',
    cancel: CANCEL,
    submit: 'Eliminar perfil',
    busy: 'Eliminando…',
    inUse: 'Este perfil está abierto en otra ventana de NightMail. Cierra esa ventana y vuelve a intentarlo.',
    sessionBusy:
      'Ahora no se puede eliminar el perfil porque hay una operación en marcha. Espera a que termine y vuelve a intentarlo.',
    notFound: 'Este perfil ya no está en este ordenador.',
    deleted: (name: string): string => `Perfil eliminado: ${name}.`,
    restartingTitle: 'Eliminando el perfil…',
    restartingText: 'NightMail se cerrará y se abrirá de nuevo.',
    // Settings card for the open profile.
    cardTitle: 'Eliminar perfil',
    cardText: 'Borra este perfil de este ordenador. Antes de hacerlo, comprueba que tienes apuntadas sus 24 palabras.',
    cardButton: 'Eliminar perfil de este ordenador',
  },
};
