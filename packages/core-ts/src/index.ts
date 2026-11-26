// Public API of @nightmail/core-ts. The deterministic sealing variant (for test vectors) is
// deliberately not exported here; import it from `@nightmail/core-ts/testing`.
export { concatBytes, fromHex, toHex } from './bytes.ts';
export {
  KEY_LENGTH, ed25519PublicKey, generateSecretKey, isLowOrderEd25519PublicKey, isUsableAuthPublicKey, x25519PublicKey,
} from './keys.ts';
export { BUCKETS, MAX_BUCKET, MAX_PLAINTEXT_LENGTH, MIN_BUCKET, bucketFor } from './padding.ts';
export {
  ENVELOPE_HEADER_LENGTH, ENVELOPE_SUITE, ENVELOPE_VERSION, MAILBOX_DOMAIN, MAX_ENVELOPE_LENGTH, MailboxCryptoError,
  bucketOfEnvelope, envelopeLengthFor, isUsableMailboxPublicKey, openMailbox, sealMailbox,
} from './mailbox.ts';
export type { MailboxErrorCode } from './mailbox.ts';
export {
  MAIL_FIXED_LENGTH, MAIL_MAGIC, MAIL_SIGNATURE_DOMAIN, MAIL_VERSION, MAX_MAIL_DATE, MAX_MAIL_LENGTH, MAX_SUBJECT_LENGTH,
  MESSAGE_ID_LENGTH, MailEncodingError, MailOpenError, SENDER_UNAVAILABLE, declaredSender, encodeMailPayload, isE2eMail,
  isMailAddress, openMail, openMailEnvelope, sealMail, senderResolverFor, signMail,
} from './mail.ts';
export type {
  MailField, MailOpenErrorCode, MailParty, OutgoingMail, ReceivedMail, SenderLookup, SenderResolver,
} from './mail.ts';
export {
  ADDR_KEY_LENGTH, MAILBOX_API_VERSION, MAX_CLOCK_SKEW_SECONDS, REQUEST_AUTH_DOMAIN, REQUEST_NONCE_LENGTH,
  RequestEncodingError, SIGNATURE_LENGTH, encodeRequest, isWithinTimeWindow, nonceRetentionDeadline,
  signRequest, verifyRequest,
} from './request-auth.ts';
export type { MailboxRequest, RequestField } from './request-auth.ts';
export { MemoryNonceStore, authenticateRequest } from './authenticate.ts';
export type { AuthContext, AuthFailure, AuthResult, NonceEntry, NonceStore } from './authenticate.ts';
export {
  NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, canonicalHost, encodeAuthHeaders, parseAuthHeaders,
} from './transport.ts';
export type { IncomingHeaders, RequestCredentials } from './transport.ts';
