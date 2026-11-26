// @nightmail/midnight: what the server and the sidecar share about NightMailRegistry.
export { Contract, Kind, ledger, Plan, REGISTRY_DIR, type Ledger, type Witnesses } from './contract.ts';
export { fromHex, InvalidInput, toHex, uint } from './input.ts';
export { addrKey, aliasAddrKey, commit, ctx, idK, leaf, NO_EXPIRY, slotNul } from './hashes.ts';
export {
  mailboxName, NAME_BYTES, nameBytes, type NameProblem, NameRejected, normalizeName, RESERVED_NAMES,
} from './names.ts';
export { aliasAddress, aliasSuffix, aliasWords, isAliasShaped, SUFFIX_CHARS, suffixOf } from './alias.ts';
export {
  bonoPositions, decodeActionState, decodeRegistry, decodeState, newAddressesBetween, NotRegistryState, type OldPrice, page,
  type PendingEntry, readRegistry, type RegistryAddress, type RegistrySnapshot,
} from './snapshot.ts';
export {
  acquireLock, currentProcessId, ensurePrivateDir, FILE_NAME_RE, fileMode, fsyncDir, hasUnixModes, InsecurePermissionsError,
  isDirFsyncUnsupported, pidExists, readOptional, realWindowsProbe, REUSED_PID_MARGIN_MS, setAsideFile, WalletInUseError,
  windowsProcessStart, type WindowsProbe, writePrivateFile,
} from './privateFiles.ts';
export { RESOLUTION_INDEX_STATE_VERSION, ResolutionIndex, type ResolutionIndexState } from './resolution.ts';
export {
  type CallStates, fetchCallStates, fetchRegistry, type GraphQL, IndexerError, IndexerUnavailable, latestHeight, readBodyCapped, readJsonCapped,
  type RegistryAt,
} from './indexer.ts';
