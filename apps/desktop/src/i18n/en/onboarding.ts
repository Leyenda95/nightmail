// English texts of the `onboarding` namespace: front screen, recovery phrase, password, App.tsx and the front screen's language selector.
// Same shape as `es/onboarding.ts`: `tsc -b` fails if a key is missing or extra.
import type { Messages } from '../index.ts';

const PASSWORD = 'Password';
const CANCEL = 'Cancel';
const CREATE_PHRASE = 'Create my recovery phrase';
const RETRYING = 'Retrying…';
const COPY_PHRASE = 'Copy';

export default {
  startup: {
    opening: 'Opening NightMail…',
    badConfigTitle: 'Configuration incomplete',
    badConfigText:
      'Some core settings are missing (for example, the server address). Check the configuration and open the app again.',
    profileInUseTitle: 'NightMail is already open',
    profileInUseText: 'This profile is already open in another NightMail window. Use that window or choose another profile.',
    chooseOther: 'Choose another profile',
    failedTitle: "Couldn't open NightMail",
    retry: 'Retry',
  },
  welcome: {
    back: 'Back',
    menu: {
      title: 'No accounts or sign-ups here.',
      text:
        'Your identity is 24 words that live only on this device. With them you create addresses that no one can ' +
        'link to each other. Not even us.',
      create: CREATE_PHRASE,
      restore: 'I already have a phrase',
    },
    unlock: {
      title: 'Unlock NightMail',
      text: 'Enter your password to open NightMail on this device.',
      password: PASSWORD,
      submit: 'Unlock',
      busy: 'Unlocking…',
    },
    create: {
      title: 'Choose a password',
      text:
        'It protects your recovery phrase on this device. No one else knows it: if you forget it, you can only get ' +
        'back in with the 24 words.',
      password: PASSWORD,
      submit: CREATE_PHRASE,
      busy: 'Creating your recovery phrase…',
    },
    showPhrase: {
      title: 'Your recovery phrase',
      text: 'Keep it somewhere safe and offline. Whoever has these 24 words can access your profile. We cannot recover it for you.',
      copy: COPY_PHRASE,
      written: "I've written it down",
    },
    restore: {
      title: 'Restore from your phrase',
      text: "Enter your 24 words in order, separated by spaces. They don't leave this device.",
      phrase: 'Recovery phrase',
      password: 'Password for this device',
      submit: 'Restore',
      busy: 'Restoring…',
      notFinished: "The restore hasn't finished",
      recoveringTitle: 'Recovering your addresses',
      recoveringText:
        "We're searching Midnight for the vouchers and addresses that come from your recovery phrase. It can take a " +
        "while, so don't close the app.",
    },
    repeatPassword: 'Repeat the password',
  },
  accounts: {
    title: 'Choose a profile',
    text: 'These are the profiles saved on this device. Each one opens with its own password.',
    name: (n: number): string => `Profile ${n}`,
    // `day`: "Nov 18, 2026" (`formatDay`).
    created: (day: string): string => `Created on ${day}`,
    recentlyUsed: 'Recently used',
    // The "+" button of the list and the title of the screen it opens.
    newProfile: 'New profile',
    newProfileText: 'Choose the network this profile will use.',
    network: 'Network',
    networks: {
      local: { title: 'Local', text: 'A test network on this computer.' },
      preprod: { title: 'Preprod', text: "Midnight's test network." },
      mainnet: { title: 'Mainnet', text: "Midnight's main network." },
    },
    soon: 'Soon',
    continue: 'Continue',
    backToAccounts: 'Back to my profiles',
    failed: "Couldn't switch profiles. Try again.",
    loadFailed: "Couldn't read the list of profiles.",
    retry: 'Try again',
  },
  seedReveal: {
    askTitle: 'See your recovery phrase',
    askText: 'Enter your password. First, make sure no one else can see the screen.',
    password: PASSWORD,
    empty: 'Enter your password.',
    cancel: CANCEL,
    show: 'Show',
    busy: 'Checking…',
    title: 'Your recovery phrase',
    hint:
      "Write it down on paper and keep it somewhere safe and offline. Don't share it with anyone: whoever has these 24 " +
      'words controls your profile.',
    copy: COPY_PHRASE,
    close: 'Close',
  },
  recovery: {
    intro: "This is what we've recovered from Midnight:",
    missingName: (what: string): string => `Missing ${what} name`,
    missingNameText: (what: string): string =>
      `We couldn't read the ${what}'s name. Enter it exactly as you chose it and we'll check that it matches.`,
    nameLabel: (what: string): string => `${what}`.replace(/^./, (c) => c.toUpperCase()) + ' name',
    later: 'You can also add the name later, in “Addresses”.',
    doneTitle: 'Restore complete',
    continue: 'Continue',
    retry: 'Retry the restore',
    retrying: RETRYING,
    notCompleted: "The restore wasn't completed.",
    safe:
      "Your recovery phrase is already saved and encrypted on this device. Until the restore finishes, you can't use " +
      'the plan or the addresses.',
  },
  resume: {
    retrying: RETRYING,
    meanwhile: 'Meanwhile, you can keep using the app.',
  },
  password: {
    title: 'Change password',
    text: 'After that, unlock NightMail with the new password.',
    current: 'Current password',
    next: 'New password',
    repeat: 'Repeat the new password',
    cancel: CANCEL,
    submit: 'Change password',
    busy: 'Changing…',
    mismatch: "The passwords don't match.",
    typeCurrent: 'Enter your current password.',
    typeNext: 'Enter the new password.',
    repeatNext: 'Repeat the new password.',
    same: 'The new password is the same as the current one.',
    notChanged: "The password hasn't been changed.",
  },
  profileName: {
    label: 'Profile name (optional)',
    tooLong: (max: number): string => `Use ${max} characters at most.`,
  },
  deleteProfile: {
    trashLabel: (name: string): string => `Delete ${name} from this computer`,
    title: 'Delete profile from this computer',
    which: (name: string): string => `Profile: ${name}`,
    device: "This profile's keys, the mail saved here and its name will be erased from this computer.",
    chain:
      'Nothing is erased on Midnight. The addresses you registered still exist and you can recover them with the 24 words.',
    words: "If you haven't written down this profile's 24 words, the profile and its balance will be lost forever.",
    password: "This profile's password",
    empty: "Enter this profile's password.",
    cancel: CANCEL,
    submit: 'Delete profile',
    busy: 'Deleting…',
    inUse: 'This profile is open in another NightMail window. Close that window and try again.',
    sessionBusy:
      "The profile can't be deleted right now because an operation is in progress. Wait for it to finish and try again.",
    notFound: 'This profile is no longer on this computer.',
    deleted: (name: string): string => `Profile deleted: ${name}.`,
    cardTitle: 'Delete profile',
    cardText: 'Erases this profile from this computer. Before doing so, check that you have written down its 24 words.',
    cardButton: 'Delete profile from this computer',
  },
} satisfies Messages['onboarding'];
