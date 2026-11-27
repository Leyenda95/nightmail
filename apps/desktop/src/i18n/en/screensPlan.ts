// English texts of the `screensPlan` namespace: plan and addresses screens.
// Same shape as `es/screensPlan.ts`: `tsc -b` fails if a key is missing or extra.
import type { Messages } from '../index.ts';
import { PAID_PLAN, TOKEN_NAME, TOKEN_NAME_PLURAL, tokenAmount } from '../brand.ts';
import { plural } from '../locale.ts';

const REFRESH = 'Refresh';

export default {
  // Words used by several screens.
  checking: 'Checking…',
  cancel: 'Cancel',
  nameNotRead: "We couldn't read its name. Enter it exactly as you chose it and we'll check that it matches.",
  /** «Mailbox name»: `what` is only the kind word from `slotKindName` («mailbox», «alias»), never «mailbox ana»
   *  (the English word order would break). */
  nameOf: (what: string): string => `${what}`.replace(/^./, (c) => c.toUpperCase()) + ' name',
  staleAfterSync:
    "The data coming from Midnight is still out of date or doesn't add up, even though the app has already synced again. " +
    'Try again in a few minutes.',
  // PlanSection.tsx
  plan: {
    keepWaiting: 'No, keep waiting',
    free: 'free',
    paid: PAID_PLAN,
    title: 'Your plan',
    quotaOf: (limit: number): string => `of ${limit}`,
    price: 'Price',
    balance: 'Your balance',
    paidFromWallet:
      "It's paid from your payment wallet, with shielded tokens on the Midnight network: the operator doesn't know who's paying.",
    confirmPayment: 'Confirm payment',
    paidTitle: PAID_PLAN,
    shieldedHint: "With shielded tokens on the Midnight network: the operator doesn't know who's paying",
    payShielded: 'Pay with shielded tokens…',
    amount: tokenAmount,
    cardHint: 'By card (simulated in this version)',
    fiat: 'Simulated payment',
    freeTitle: 'Free',
    requestFree: 'Request the free plan',
    buyAnother: 'Buy another voucher',
    opening: 'Opening the wallet…',
  },
  // WalletSection.tsx
  wallet: {
    title: 'Payment wallet',
    intro:
      'With it you can pay for the plan fully privately, thanks to shielded tokens on the Midnight network.',
    dustInfo: "DUST is a resource used to pay fees. It regenerates on its own from the wallet's NIGHT.",
    dustInfoLabel: 'What DUST is',
    tokenName: TOKEN_NAME,
    receiveNight: 'Address to receive NIGHT',
    addressUnavailable: `Not available right now. Press ${REFRESH} later.`,
    refresh: REFRESH,
    view: 'View wallet',
    requestToken: `Request ${TOKEN_NAME}`,
    tokenNote: `The ${TOKEN_NAME} is a test currency with no real value. It's used to pay for the plan on this test network.`,
    faucetBlocked: `You need NIGHT. Send it to the address above and press ${REFRESH}.`,
    faucetDone: `${TOKEN_NAME_PLURAL} requested. If they don't show up yet, press ${REFRESH} in a few seconds.`,
    waitForPlan: 'Wait for the plan operation to finish.',
    opening: 'Opening the wallet',
    openingNote: 'The first time can take a while.',
  },
  // AddressesSection.tsx
  addresses: {
    new: 'new',
    createdOn: (day: string): string => `Created on ${day}`,
    seeMail: 'See mail',
    createdBold: 'Address created.',
    createdRest: ' It can now receive mail. No one can link it to your other addresses.',
  },
  // PendingSection.tsx
  pending: {
    keepGoing: 'No, keep going',
    yesCancel: 'Yes, cancel',
    cancelTitle: 'Cancel the creation?',
    cancelBody: "It hadn't finished being created yet. Its slot in your plan becomes free for another address.",
    title: 'In progress',
  },
  // NewAddress.tsx
  newAddress: {
    leftBefore: 'Slots left: ',
    leftMiddle: ' of ',
    available: (name: string): string => `“${name}” is available`,
    unavailable: (name: string): string => `“${name}” isn't available. Try another name.`,
    viewPlans: 'View plans',
    mailbox: 'Mailbox',
    alias: 'Alias',
    youChoose: 'You choose the name.',
    mailboxName: 'Mailbox name',
    creating: 'Creating…',
    createMailbox: 'Create mailbox',
    check: 'Check',
    createAlias: 'Create alias',
    aliasNote: 'Random name, for signing up on websites or giving out a throwaway address.',
    proofNote: 'It may take a while. You can keep reading your mail.',
  },
  // ProvideName.tsx
  provideName: {
    save: 'Save name',
  },
  // ServiceStatus.tsx
  service: {
    title: 'Service status',
    down: (failures: number): string =>
      `down (${plural(failures, { one: '1 failed attempt', other: `${failures} failed attempts` }, 'en')})`,
    noConnection: "no connection, the component that talks to Midnight isn't responding",
    midnightNetwork: 'Midnight network',
    server: 'NightMail server',
    checkConnection: 'Check connection',
  },
} satisfies Messages['screensPlan'];
