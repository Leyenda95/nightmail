// English texts of the `settings` namespace: Settings and the language names.
// Same shape as `es/settings.ts`: `tsc -b` fails if a key is missing or extra.
import type { Messages } from '../index.ts';

export default {
  // As in Spanish: each language with its own name.
  languageNames: { en: 'English', es: 'Español' },
  language: {
    legend: 'Language',
  },
  layout: {
    legend: 'Layout',
    three: { title: 'Three panels', text: 'The list and the message, side by side.' },
    two: { title: 'Two panels', text: 'The message opens in place of the list. Works better in narrow windows.' },
    forced: "Three panels don't fit in this window at this size, so two are shown. Make the window bigger or choose a smaller size.",
  },
  theme: {
    legend: 'Theme',
    system: { title: 'System', text: 'Follows your computer.' },
    light: { title: 'Light', text: 'Warm paper.' },
    dark: { title: 'Dark', text: 'For the night.' },
    note: 'HTML mail always shows on pale paper, with any theme.',
  },
  size: {
    legend: 'Interface size',
    automatic: (percent: string): string => `Automatic (${percent})`,
    automaticText: 'Matches your screen.',
    standard: 'Normal size.',
    larger: (percent: string): string => `${percent} larger.`,
    note: 'Makes the whole app bigger. For now HTML mail stays at its own size, but plain-text mail does grow.',
  },
  sound: {
    legend: 'Sound for new mail',
    on: { title: 'On', text: 'A short sound when mail arrives while you are not viewing the inbox.' },
    off: { title: 'Off', text: 'Only the on-screen notice.' },
  },
  badgeCount: {
    legend: 'Show the number of unread emails on the taskbar icon',
    on: { title: 'On', text: 'The NightMail icon shows how many unread emails are in the inbox.' },
    off: { title: 'Off', text: 'The icon shows no number. The padlock still appears when NightMail is locked.' },
  },
  profileName: {
    title: 'Profile name',
    text: (max: number): string =>
      `Shown in the profile list before unlocking and stored unencrypted on this device. Up to ${max} characters. If you leave it empty, Profile and its number are shown.`,
    label: 'Name',
    save: 'Save name',
    saving: 'Saving…',
    saved: 'Profile name saved.',
    tooLong: (max: number): string => `Use ${max} characters at most.`,
    failed: "Couldn't save the profile name. Try again.",
    loadFailed: "Couldn't read the profile name. Open Settings again.",
  },
  password: {
    title: 'Password',
    text:
      'Protects your recovery phrase on this device. If you forget it, you can only get back in with the 24 words. ' +
      'If you change the password, an old backup of this device still opens with the old password.',
    changed: 'Password changed.',
    changedNext: 'Next time, unlock NightMail with the new one.',
    change: 'Change password',
  },
  version: 'NightMail version',
} satisfies Messages['settings'];
