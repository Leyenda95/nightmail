// Typed wrappers around `invoke`. Argument names are camelCase, as Tauri expects.
import { invoke } from '@tauri-apps/api/core';
import type { AccountView } from './bindings/AccountView.ts';
import type { AddressView } from './bindings/AddressView.ts';
import type { AppStatus } from './bindings/AppStatus.ts';
import type { BonoInfo } from './bindings/BonoInfo.ts';
import type { DeleteOutcome } from './bindings/DeleteOutcome.ts';
import type { FlagsInput } from './bindings/FlagsInput.ts';
import type { LinkInfo } from './bindings/LinkInfo.ts';
import type { MessageDetail } from './bindings/MessageDetail.ts';
import type { MessageQuery } from './bindings/MessageQuery.ts';
import type { MessageView } from './bindings/MessageView.ts';
import type { MidnightHealth } from './bindings/MidnightHealth.ts';
import type { NameCheck } from './bindings/NameCheck.ts';
import type { PendingSlot } from './bindings/PendingSlot.ts';
import type { PeriodInput } from './bindings/PeriodInput.ts';
import type { PlanView } from './bindings/PlanView.ts';
import type { RecoveryReport } from './bindings/RecoveryReport.ts';
import type { SeedPhrase } from './bindings/SeedPhrase.ts';
import type { SentDetail } from './bindings/SentDetail.ts';
import type { SentQuery } from './bindings/SentQuery.ts';
import type { SentView } from './bindings/SentView.ts';
import type { ServerHealth } from './bindings/ServerHealth.ts';
import type { SidecarStatus } from './bindings/SidecarStatus.ts';
import type { SlotId } from './bindings/SlotId.ts';
import type { SwitchOutcome } from './bindings/SwitchOutcome.ts';
import type { WalletView } from './bindings/WalletView.ts';

let opCounter = 0;
/** Increasing id of a long-running operation (picked by the UI; progress events carry it). */
export const nextOp = (): number => ++opCounter;

export const api = {
  sidecarStatus: () => invoke<SidecarStatus>('sidecar_status'),
  sidecarPing: () => invoke<MidnightHealth>('sidecar_ping'),
  serverPing: () => invoke<ServerHealth>('server_ping'),
  appStatus: () => invoke<AppStatus>('app_status'),
  createSeed: (password: string) => invoke<SeedPhrase>('create_seed', { password }),
  unlock: (password: string) => invoke<void>('unlock', { password }),
  lock: () => invoke<void>('lock'),
  restoreSeed: (phrase: string, password: string) => invoke<void>('restore_seed', { phrase, password }),
  recover: (op: number) => invoke<RecoveryReport>('recover', { op }),
  revealSeed: (password: string) => invoke<SeedPhrase>('reveal_seed', { password }),
  changePassword: (current: string, next: string) => invoke<void>('change_password', { current, new: next }),
  getPlan: () => invoke<PlanView>('get_plan'),
  getFreePlan: (op: number) => invoke<BonoInfo>('get_free_plan', { op }),
  payFiat: (period: PeriodInput, op: number) => invoke<BonoInfo>('pay_fiat', { period, op }),
  getPrice: () => invoke<string>('get_price'),
  payShielded: (amount: string, op: number) => invoke<BonoInfo>('pay_shielded', { amount, op }),
  walletInfo: (op: number) => invoke<WalletView>('wallet_info', { op }),
  faucet: (op: number) => invoke<void>('faucet', { op }),
  listAddresses: () => invoke<AddressView[]>('list_addresses'),
  checkName: (name: string) => invoke<NameCheck>('check_name', { name }),
  createMailbox: (name: string, op: number) => invoke<AddressView>('create_mailbox', { name, op }),
  createAlias: (op: number) => invoke<AddressView>('create_alias', { op }),
  provideName: (slot: SlotId, name: string, op: number) => invoke<AddressView>('provide_name', { slot, name, op }),
  // Irreversible local mark (no chain involved): the address stops being listed and its mail is hidden. `addrKey` in hex.
  abandonAddress: (addrKey: string) => invoke<void>('abandon_address', { addrKey }),
  listMessages: (query: MessageQuery) => invoke<MessageView[]>('list_messages', { query }),
  getMessage: (id: number) => invoke<MessageDetail>('get_message', { id }),
  setFlags: (id: number, flags: FlagsInput) => invoke<void>('set_flags', { id, flags }),
  // The same flags on several messages, all or none (list selection; the core caps it at one whole list).
  setFlagsMany: (ids: number[], flags: FlagsInput) => invoke<void>('set_flags_many', { ids, flags }),
  syncNow: () => invoke<void>('sync_now'),
  // Sending to NightMail addresses and "Enviados". `send_mail` fails (`SendError`) only when nothing was stored or sent;
  // once stored, a refused delivery is the message's state (`failed`), to retry with `retrySent`.
  sendMail: (fromAddrKey: string, toText: string, subject: string, body: string) =>
    invoke<SentView>('send_mail', { fromAddrKey, toText, subject, body }),
  retrySent: (id: number) => invoke<SentView>('retry_sent', { id }),
  listSent: (query: SentQuery) => invoke<SentView[]>('list_sent', { query }),
  getSent: (id: number) => invoke<SentDetail>('get_sent', { id }),
  deleteSent: (id: number) => invoke<void>('delete_sent', { id }),
  // From one of our addresses (`addrKey` in hex) or, with `null`, from all.
  countSent: (addrKey: string | null) => invoke<number>('count_sent', { addrKey }),
  // Actions after an error.
  retryStale: () => invoke<void>('retry_stale'),
  listPendingSlots: () => invoke<PendingSlot[]>('list_pending_slots'),
  resumePausedSlot: (slot: SlotId, op: number) => invoke<AddressView>('resume_paused_slot', { slot, op }),
  abandonSlot: (slot: SlotId) => invoke<void>('abandon_slot', { slot }),
  forgetPendingBono: (n: number, k: number) => invoke<void>('forget_pending_bono', { n, k }),
  resumeNow: () => invoke<void>('resume_now'),
  inspectLink: (url: string) => invoke<LinkInfo>('inspect_link', { url }),
  openLink: (url: string) => invoke<void>('open_link', { url }),
  // Windows taskbar badge (`badge.ts`). No effect outside Windows. Returns whether the padlock was kept
  // (with no session in the core it sets it itself, whatever the UI asks for).
  setTaskbarBadge: (unread: number, locked: boolean, showCount: boolean) =>
    invoke<boolean>('set_taskbar_badge', { unread, locked, showCount }),
  // New-mail sound played by the system, outside the webview (`chime.ts`). `false` outside Windows.
  playChime: () => invoke<boolean>('play_chime'),
  // Accounts on this device (`accounts.ts`). They answer without a core too (account open in another window).
  // Switching or creating restarts the app into that account, only with the session locked.
  listAccounts: () => invoke<AccountView[]>('list_accounts'),
  switchAccount: (id: string) => invoke<SwitchOutcome>('switch_account', { id }),
  newAccount: () => invoke<SwitchOutcome>('new_account'),
  // The open account's name, when creating or restoring it or from Settings (session open). Empty: the automatic name,
  // keeping its number. Answers the account as listed now.
  setAccountName: (name: string) => invoke<AccountView>('set_account_name', { name }),
  // Deletes a profile's files on this computer (nothing on the chain), after checking its password as unlocking does.
  // `restarting`: it was the open one and the app restarts (into the profile list, or the welcome screen if none is left).
  deleteAccount: (id: string, password: string) => invoke<DeleteOutcome>('delete_account', { id, password }),
  // Once, at startup: the previous run deleted its open profile and the profile list goes in front.
  takeShowAccounts: () => invoke<boolean>('take_show_accounts'),
};
