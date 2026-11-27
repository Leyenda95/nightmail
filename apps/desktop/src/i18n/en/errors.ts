// English texts of the `errors` namespace.
// Same shape as `es/errors.ts`: `tsc -b` fails if a key is missing or extra.
//
// The "safe" sentences (`safe`) say exactly the same as in Spanish, no more and no less, and are missing in the
// same places. Why each one is true: the comments in `es/errors.ts`.
import type { ErrorText } from '../../errors.ts';
import { PAID_PLAN, TOKEN_NAME_PLURAL } from '../brand.ts';
import type { Messages } from '../index.ts';

/** As in `es/errors.ts`: a `null` part is not stored. */
const parts = (what: string, safe: string | null, action: string | null): ErrorText => ({
  what,
  ...(safe === null ? {} : { safe }),
  ...(action === null ? {} : { action }),
});

const NOT_PAID = 'Nothing has been paid.';

const RETRY = 'Try again.';
const RETRY_SOON = 'Try again in a moment.';
const OTHER_NAME = 'Choose another name.';

const GENERIC = parts('An unexpected error occurred.', null, RETRY);

const STORAGE = parts(
  "The app's data on this device couldn't be read or saved.",
  null,
  'Close and reopen the app.',
);

export default {
  generic: GENERIC,
  retry: RETRY,
  retrySoon: RETRY_SOON,
  otherName: OTHER_NAME,

  simple: {
    // --- Seed phrase and session
    noSeed: parts(
      "There's no recovery phrase on this device yet.",
      null,
      'Create one or restore yours with its 24 words.',
    ),
    seedExists: parts("There's already a recovery phrase on this device.", null, 'Unlock with your password.'),
    wrongPassword: parts('Wrong password.', null, RETRY),
    invalidPhrase: parts(
      "The recovery phrase isn't valid.",
      null,
      'Check that all 24 words are there, in order and without typos.',
    ),
    emptyPassword: parts("The password can't be empty.", null, 'Enter a password.'),
    insecureFiles: parts(
      "NightMail's files on this device aren't private, so the app won't open them.",
      null,
      'Make sure only your user can read and change them, then open the app again.',
    ),
    outOfMemory: parts(
      "This device doesn't have enough free memory to work with the recovery phrase.",
      null,
      'Close other apps and try again.',
    ),
    notUnlocked: parts('NightMail is locked.', null, 'Unlock it with your password.'),
    alreadyUnlocked: parts('NightMail is already unlocked.', null, null),
    badConfig: parts(
      'Some app settings are missing or invalid.',
      null,
      'Check the configuration and open the app again.',
    ),
    profileInUse: parts(
      'This profile is already open in another NightMail window.',
      null,
      'Use that window, or close it and open the app again.',
    ),
    storage: STORAGE,
    notFound: parts("That message couldn't be found.", null, 'Go back to the inbox.'),
    invalidInput: parts("That value isn't valid or is too long.", null, 'Fix it and try again.'),
    sessionBusy: parts(
      "NightMail can't be locked right now: an operation is under way.",
      null,
      'Wait for it to finish, then try locking again.',
    ),
    profileChanged: parts('Another profile was opened in the meantime.', null, 'Try again from the profile list.'),
    recoveryPending: parts(
      "The restore hasn't finished.",
      'Your recovery phrase is already saved and encrypted on this device.',
      'Finish the restore. After that you can use the plan and the addresses.',
    ),
    noTestToken: parts(`${TOKEN_NAME_PLURAL} can't be requested on this network.`, null, null),
    internal: GENERIC,
    // --- Connection to Midnight
    midnightUnavailable: parts("There's no connection to Midnight right now.", null, RETRY_SOON),
    midnightRestarting: parts('Midnight is restarting.', null, 'Try again in a few seconds.'),
    midnightTimeout: parts("Midnight didn't respond in time.", null, RETRY),
    sidecarTooOld: parts(
      'The part of NightMail that connects to Midnight is older than this app.',
      'Nothing has been paid or sent this time.',
      'Reinstall NightMail.',
    ),
    contractMismatch: parts(
      "This version of NightMail doesn't match the service on Midnight.",
      null,
      "Check whether there's a new version of NightMail.",
    ),
    clock: parts(
      "This device's time doesn't match Midnight's.",
      null,
      'Set the correct time on the device and try again.',
    ),
    staleState: parts(
      "The data coming from Midnight is out of date or doesn't add up.",
      null,
      'Sync again and repeat the operation.',
    ),
    // --- Plan and bonos
    alreadyHasPlan: parts(
      "You already have the free plan. There's only one per recovery phrase.",
      null,
      `If you need more addresses, take a look at the ${PAID_PLAN} plan.`,
    ),
    busy: parts('Another plan or wallet operation is under way.', null, 'Wait for it to finish and try again.'),
    serviceUnavailable: parts("The service isn't available right now.", null, 'Try again in a few minutes.'),
    serverUnreachable: parts("The NightMail server isn't responding.", null, 'Try again in a few minutes.'),
    captchaFailed: parts('The verification failed.', 'No voucher has been issued with this attempt.', RETRY),
    paymentFailed: parts(
      "The card payment wasn't accepted.",
      "This attempt hasn't charged anything.",
      'Try again, or cancel the pending payment to pay another way.',
    ),
    issueFailed: parts("The service couldn't issue the voucher.", null, 'Request it again.'),
    badReceipt: parts(
      "The service gave a receipt that can't be verified. We don't know whether your request was recorded.",
      null,
      'Try again later.',
    ),
    stillPending: parts(
      "There's a pending operation that doesn't show as finished on Midnight yet.",
      "It's still saved. Repeating it won't pay twice or spend twice.",
      "Wait a few minutes and try again. If it's a payment and you want to make it another way, cancel the pending " +
        'payment first.',
    ),
    priceChanged: parts('The price has changed.', NOT_PAID, 'Check the new price and pay again.'),
    store: STORAGE,
    // --- Addresses
    nameTaken: parts('That name is already in use.', null, OTHER_NAME),
    noFreeSlot: parts(
      "You don't have any free slots to create addresses.",
      null,
      'To create more, see the options in “Plan & wallet”.',
    ),
    attemptsExhausted: parts(
      'The address has stopped after several attempts.',
      null,
      'To try again, press Resume in “Addresses”.',
    ),
    slotBurned: parts(
      "That slot can't be used anymore: it was spent without producing an address.",
      null,
      'If you have slots left, create the address again.',
    ),
    needsName: parts(
      'A mailbox name is missing.',
      null,
      "Enter it exactly as you chose it and we'll check that it matches.",
    ),
    wrongName: parts("That name isn't the name of this mailbox.", null, 'Enter it exactly as you chose it.'),
    aliasSuffixTaken: parts("The alias couldn't be created: another alias already uses its ending.", null, null),
    relayerRefused: parts(
      'The service that sends operations to Midnight has refused this one.',
      'The address is left unfinished, saved on this device.',
      'Try again later from “In progress”.',
    ),
    // --- Links: the text already says it does not open.
    linkTooLong: parts("This link won't open because it's too long.", null, null),
    linkHiddenChars: parts("This link won't open because it has spaces or hidden characters.", null, null),
    linkMalformed: parts("This link won't open because it isn't a valid web address.", null, null),
    linkScheme: parts("This link won't open. Only web addresses (https or http) can be opened.", null, null),
    linkCredentials: parts("This link won't open because it hides a username or a password.", null, null),
    linkLocal: parts(
      "This link points to your own computer or to a private network and can't be opened from here.",
      null,
      null,
    ),
    browserFailed: parts("The browser couldn't be opened.", null, null),
    // --- Sending mail
    senderUnavailable: parts("The address chosen in “From” can't send mail right now.", null, 'Choose another address.'),
    subjectInvalid: parts(
      "The subject is too long or has hidden characters that can't be sent.",
      null,
      'Shorten it or, if you pasted it from somewhere else, type it again.',
    ),
    bodyInvalid: parts(
      "The message has hidden characters that can't be sent.",
      null,
      'If you pasted the text from somewhere else, type it again.',
    ),
    messageTooLarge: parts('The message is too large to send.', null, 'Shorten it and try again.'),
    recipientInvalid: parts("That address isn't valid.", null, 'Check that it is spelled correctly.'),
    recipientForeignDomain: parts(
      'For now, mail can only be sent to NightMail addresses.',
      null,
      'Check the part after the at sign (@).',
    ),
    recipientNotFound: parts("That address wasn't found in NightMail.", null, 'Check that it is spelled correctly.'),
    recipientUnusable: parts("That address exists, but it can't receive mail right now.", null, null),
    registryUnavailable: parts(
      "The recipient's address couldn't be checked.",
      null,
      'Try again in a few minutes.',
    ),
    registryStale: parts(
      "The recipient's address couldn't be checked because the Midnight data isn't up to date.",
      null,
      RETRY_SOON,
    ),
    registryClock: parts(
      "This computer's date and time don't match those of Midnight.",
      null,
      'Correct them and try again.',
    ),
    serverTimeUnavailable: parts(
      "The NightMail server's time couldn't be read.",
      null,
      'Try again in a few minutes.',
    ),
  },

  wait: {
    moment: 'a moment',
    seconds: (n: number) => `${n} s`,
    minutes: (n: number) => `${n} min`,
  },

  tooManyAttempts: {
    what: 'Too many attempts.',
    action: (wait: string) => `Wait ${wait} and try again.`,
  },

  nameRejected: {
    what: (problem: string) => `That name ${problem}.`,
    problem: {
      invalid: "isn't valid",
      'alias-form': 'looks like an alias',
      reserved: 'is reserved',
    },
    unknown: "isn't allowed",
  },

  bonoNotReady: {
    safe: 'The voucher is confirmed. You only need to wait.',
    what: "Your voucher can't be used yet.",
    action: 'Try again later.',
    whatBefore: (at: string) => `Your voucher can't be used before ${at}.`,
    actionAfter: 'Try again after that time.',
  },

  callRejected: {
    what: (problem: string) => `The operation can't be done: ${problem}.`,
    problem: {
      // Only this reason goes without yet or still, as in Spanish: waiting does not fix it.
      'not-a-bono': "Midnight doesn't recognize your voucher",
      'no-slots-left': 'there are no slots left in your plan',
      'slot-already-used': 'that slot had already been used',
      'address-taken': 'the name already belongs to another address',
      'wrong-token': "the token isn't the one required",
      'wrong-amount': "the amount isn't the current price",
      'old-price-expired': 'the price you accepted has already expired',
      other: "it didn't pass a check",
    },
  },

  rateLimited: {
    what: 'There are too many requests right now.',
    action: (wait: string) => `Try again in ${wait}.`,
  },

  insufficientFunds: {
    dust: parts(
      "The payment wallet doesn't have enough DUST for the fee.",
      NOT_PAID,
      'DUST is generated automatically from NIGHT: send NIGHT to the wallet or, if it already has some, wait a few minutes.',
    ),
    token: parts(
      "There isn't enough balance in the payment wallet.",
      NOT_PAID,
      `If you're on a test network, request ${TOKEN_NAME_PLURAL} from the wallet and try again.`,
    ),
    unknown: parts("The payment wallet doesn't have enough balance.", null, 'Check the wallet and try again.'),
  },

  wallet: {
    what: (problem: string) => `The payment wallet isn't available: ${problem}.`,
    problem: {
      'not-open': "it isn't open",
      'already-open': "it's already open",
      'in-use': 'another program is using it',
      'not-synced': "it's still syncing",
    },
    unknown: 'unknown reason',
    inUseAction: "If another NightMail window is open, close it. If there isn't one, wait a moment and try again. If it happens again, restart the computer.",
    notPaid: "This attempt hasn't paid anything.",
  },

  midnightError: {
    what: 'Midnight returned an error.',
    withCode: (code: number) => `Midnight returned an error (code ${code}).`,
  },
} satisfies Messages['errors'];
