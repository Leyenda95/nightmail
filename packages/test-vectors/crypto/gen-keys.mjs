// Generates keys.json and name-cipher.json (key derivation, seed file and nameCipher; README §3).
//
// Independent of the Rust core: only `node:crypto` plus the BIP39 English wordlist (resolved from
// `packages/midnight`, which pins it). HChaCha20 is implemented here and checked against the
// draft-irtf-cfrg-xchacha §2.2.1 vector; BIP39 base vectors are Trezor's.
// Regenerate only when the format changes, from the repo root (Node >= 24.7 for argon2Sync):
// `node packages/test-vectors/crypto/gen-keys.mjs`; add `--check` to compare without writing (exit 1 on diff).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  argon2Sync,
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  pbkdf2Sync,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const fromMidnight = createRequire(new URL("../../midnight/package.json", import.meta.url));
const { wordlist } = await import(fromMidnight.resolve("@scure/bip39/wordlists/english.js"));

const OUT = new URL(".", import.meta.url);
const CHECK = process.argv.includes("--check");

/** Writes the file, or in `--check` mode verifies the stored one is identical. */
function emit(name, data) {
  const url = new URL(name, OUT);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (!CHECK) return writeFileSync(url, text);
  if (readFileSync(url, "utf8") !== text) {
    console.error(`${name}: does not match what gen-keys.mjs generates`);
    process.exitCode = 1;
  }
}
const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Buffer.from(h, "hex");
const ascii = (s) => Buffer.from(s, "ascii");

// ---------- BIP39 ----------

/** 32 bytes of entropy → 24 words (BIP39: 256 bits + 8 checksum bits, in groups of 11). */
function entropyToPhrase(entropy) {
  assert.equal(entropy.length, 32);
  const bits = [...entropy, createHash("sha256").update(entropy).digest()[0]]
    .map((b) => b.toString(2).padStart(8, "0"))
    .join("");
  return Array.from({ length: 24 }, (_, i) => wordlist[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]).join(" ");
}

/** BIP39 seed: PBKDF2-HMAC-SHA512(NFKD phrase, "mnemonic" ‖ passphrase, 2048, 64). */
const bip39Seed = (phrase, passphrase = "") =>
  pbkdf2Sync(Buffer.from(phrase.normalize("NFKD"), "utf8"), Buffer.from(`mnemonic${passphrase}`.normalize("NFKD"), "utf8"), 2048, 64, "sha512");

// Official Trezor vectors (24 words): entropy, phrase and seed with passphrase "TREZOR".
const TREZOR = [
  {
    entropy: "00".repeat(32),
    phrase: `${"abandon ".repeat(23)}art`,
    trezorSeed:
      "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8",
  },
  {
    entropy: "7f".repeat(32),
    phrase: `${"legal winner thank year wave sausage worth useful ".repeat(3)}`.trim().replace(/useful$/, "title"),
    trezorSeed: null,
  },
  { entropy: "ff".repeat(32), phrase: `${"zoo ".repeat(23)}vote`, trezorSeed: null },
];

const phrases = TREZOR.map(({ entropy, phrase, trezorSeed }) => {
  assert.equal(entropyToPhrase(fromHex(entropy)), phrase, `phrase for ${entropy}`);
  if (trezorSeed) assert.equal(hex(bip39Seed(phrase, "TREZOR")), trezorSeed, "Trezor vector");
  return { entropy, phrase, seed: hex(bip39Seed(phrase)) };
});

// ---------- Derivation ----------

const LABEL_PREFIX = "nightmail/v1/";
const info = (label) => ascii(LABEL_PREFIX + label);
const derive = (master, label) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info(label), 32));

/** Public key of a 32-byte secret (RFC 7748 / RFC 8032) via node:crypto PKCS#8 → SPKI. */
function publicKey(type, secret) {
  const prefix = { x25519: "302e020100300506032b656e04220420", ed25519: "302e020100300506032b657004220420" }[type];
  const key = createPrivateKey({ key: Buffer.concat([fromHex(prefix), secret]), format: "der", type: "pkcs8" });
  return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
}

const derivationPhrase = phrases[1];
const master = fromHex(derivationPhrase.seed);
const out = (label) => ({ label, info: hex(info(label)), okm: hex(derive(master, label)) });

const derivation = {
  phrase: derivationPhrase.phrase,
  master: derivationPhrase.seed,
  bono: [0, 1, 4294967295].map((n) => ({ n, ...out(`bono/${n}`) })),
  mailboxSalt: [
    [0, 0],
    [3, 4],
  ].map(([n, j]) => ({ n, j, ...out(`salt/${n}/mailbox/${j}`) })),
  fixed: Object.fromEntries(
    [
      ["names", "names"],
      ["wallet", "wallet"],
      ["walletState", "wallet-state"],
      ["db", "db"],
    ].map(([k, label]) => [k, out(label)]),
  ),
  addresses: [
    [0, "mailbox", 0],
    [2, "alias", 19],
    [7, "mailbox", 255],
  ].map(([n, kind, j]) => {
    const enc = out(`addr/${n}/${kind}/${j}/enc`);
    const auth = out(`addr/${n}/${kind}/${j}/auth`);
    return {
      n,
      kind,
      j,
      enc: { ...enc, publicKey: hex(publicKey("x25519", fromHex(enc.okm))) },
      auth: { ...auth, publicKey: hex(publicKey("ed25519", fromHex(auth.okm))) },
    };
  }),
};

// ---------- Seed file (seed.v1) ----------

const SEED_FILE_DOMAIN = "nightmail:seed-file:v1";

/** Canonical JSON of the parameters: no whitespace, fields in this order. */
const canonicalParams = ({ m, t, p, salt, nonce }) =>
  `{"version":1,"kdf":"argon2id","m":${m},"t":${t},"p":${p},"salt":"${salt}","nonce":"${nonce}"}`;

/** The password goes into Argon2id as NFC, so its equivalent forms (`equivalentPasswords`) open it too. */
function seedFile({ password, entropy, m, t, p, salt, nonce }) {
  const message = Buffer.from(password.normalize("NFC"), "utf8");
  const key = argon2Sync("argon2id", { message, nonce: fromHex(salt), parallelism: p, tagLength: 32, memory: m, passes: t });
  const aad = Buffer.concat([ascii(SEED_FILE_DOMAIN), ascii(canonicalParams({ m, t, p, salt, nonce }))]);
  const cipher = createCipheriv("aes-256-gcm", key, fromHex(nonce));
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(fromHex(entropy)), cipher.final(), cipher.getAuthTag()]);
  const file = `${canonicalParams({ m, t, p, salt, nonce }).slice(0, -1)},"ciphertext":"${hex(ciphertext)}"}`;
  const equivalentPasswords = [...new Set([password.normalize("NFD"), password.normalize("NFC")])].filter((x) => x !== password);
  // NFKC (unlike NFC) would turn `ª` into `a`; those forms must not open (NFC is chosen on purpose).
  const nonEquivalentPasswords = [password.normalize("NFKC")].filter((x) => x.normalize("NFC") !== password.normalize("NFC"));
  return { password, equivalentPasswords, nonEquivalentPasswords, entropy, phrase: entropyToPhrase(fromHex(entropy)), key: hex(key), aad: hex(aad), file };
}

const seedFiles = [
  // The minimums the core accepts (m = 19456 KiB, t = 2): opens under the production policy.
  seedFile({ password: "correct horse battery staple", entropy: derivationPhrase.entropy, m: 19456, t: 2, p: 1, salt: "000102030405060708090a0b0c0d0e0f", nonce: "a0a1a2a3a4a5a6a7a8a9aaab" }),
  // Non-ASCII password: its NFD form (ñ = n + combining tilde) has different bytes but still opens.
  seedFile({ password: "contraseña ñ €", entropy: "00".repeat(32), m: 19456, t: 2, p: 1, salt: "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff", nonce: "000000000000000000000001" }),
  // `ª` and `º`: NFC keeps them, NFKC maps them to `a` and `o` (tells NFC and NFKC apart).
  seedFile({ password: "señora nº 1ª", entropy: "80".repeat(32), m: 19456, t: 2, p: 1, salt: "11111111111111111111111111111111", nonce: "222222222222222222222222" }),
];
assert.equal(seedFiles[1].equivalentPasswords.length, 1, "the non-ASCII password has a different NFD form");
assert.equal(seedFiles[2].nonEquivalentPasswords.length, 1, "the NFKC form of the third one is different");

emit("keys.json", {
  note: "NightMail key derivation and seed file. Generated by gen-keys.mjs (node:crypto, independent of the Rust core); the specification is in README.md §3. Lowercase hex without 0x. The Rust core must reproduce `phrases` (entropy ↔ phrase and seed) and every output of `derivation` with its typed API (public keys included), and open `seedFiles` with their password and with their `equivalentPasswords` (NFC), but not with their `nonEquivalentPasswords` (NFKC).",
  constants: {
    labelPrefix: LABEL_PREFIX,
    seedFileDomain: SEED_FILE_DOMAIN,
    minimumKdf: { m: 19456, t: 2 },
    maximumKdf: { m: 262144, t: 16, p: 16 },
    maxSeedFileLength: 1024,
  },
  phrases,
  derivation,
  seedFiles,
});

// ---------- nameCipher ----------

const rotl = (v, c) => ((v << c) | (v >>> (32 - c))) >>> 0;
function quarterRound(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

/** HChaCha20 (draft-irtf-cfrg-xchacha §2.2): 32-byte subkey from the key and 16 nonce bytes. */
function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  for (let i = 0; i < 10; i++) {
    quarterRound(s, 0, 4, 8, 12); quarterRound(s, 1, 5, 9, 13); quarterRound(s, 2, 6, 10, 14); quarterRound(s, 3, 7, 11, 15);
    quarterRound(s, 0, 5, 10, 15); quarterRound(s, 1, 6, 11, 12); quarterRound(s, 2, 7, 8, 13); quarterRound(s, 3, 4, 9, 14);
  }
  const outWords = [s[0], s[1], s[2], s[3], s[12], s[13], s[14], s[15]];
  const result = Buffer.alloc(32);
  outWords.forEach((w, i) => result.writeUInt32LE(w, i * 4));
  return result;
}
assert.equal(
  hex(hchacha20(fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), fromHex("000000090000004a0000000031415927"))),
  "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc",
  "HChaCha20 vector",
);

/** XChaCha20-Poly1305 = ChaCha20-Poly1305 with the HChaCha20 subkey and nonce 0⁴ ‖ nonce[16..24]. */
function xchachaSeal(key, nonce24, aad, plaintext) {
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const cipher = createCipheriv("chacha20-poly1305", subkey, Buffer.concat([Buffer.alloc(4), nonce24.subarray(16)]), { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

const NAME_DOMAIN = "nightmail:name-cipher:v1";
const nameAad = (slotNul) => Buffer.concat([ascii(NAME_DOMAIN), slotNul]);
const padName = (bytes) => Buffer.concat([bytes, Buffer.alloc(64 - bytes.length)]);
const sealPadded = (key, nonce, slotNul, padded) => Buffer.concat([nonce, xchachaSeal(key, nonce, nameAad(slotNul), padded)]);

const nameKey = fromHex(derivation.fixed.names.okm);
const slotNul = createHash("sha256").update("slotNul de prueba").digest();
const nonceFor = (i) => createHash("sha256").update(`nonce ${i}`).digest().subarray(0, 24);

const names = ["alice", "a", "bob.smith-99", "x".repeat(64), "josé", "名前"].map((name, i) => {
  const nonce = nonceFor(i);
  const nameCipher = sealPadded(nameKey, nonce, slotNul, padName(Buffer.from(name, "utf8")));
  assert.equal(nameCipher.length, 104);
  return { name, nonce: hex(nonce), nameCipher: hex(nameCipher) };
});

const flip = (buf, index) => {
  const copy = Buffer.from(buf);
  copy[index] ^= 0x01;
  return copy;
};
const first = fromHex(names[0].nameCipher);
const failure = (name, nameCipher, slot = slotNul) => ({ name, slotNul: hex(slot), nameCipher: hex(nameCipher) });
const sealedBadText = (i, padded) => sealPadded(nameKey, nonceFor(100 + i), slotNul, padded);

const openFailures = [
  failure("nonce altered", flip(first, 0)),
  failure("ciphertext altered", flip(first, 30)),
  failure("tag altered", flip(first, 103)),
  failure("another slotNul", first, flip(slotNul, 0)),
  failure("alias: 104 zeros", Buffer.alloc(104)),
  failure("empty name (64 encrypted zeros)", sealedBadText(0, Buffer.alloc(64))),
  failure("NUL inside the name", sealedBadText(1, padName(Buffer.from("ab\0cd", "utf8")))),
  failure("invalid UTF-8", sealedBadText(2, padName(Buffer.from([0x61, 0xff, 0x62])))),
  failure("UTF-8 cut at the last byte", sealedBadText(3, padName(Buffer.from("名", "utf8").subarray(0, 2)))),
];

emit("name-cipher.json", {
  note: "NightMail nameCipher (XChaCha20-Poly1305). Generated by gen-keys.mjs with node:crypto (chacha20-poly1305) and HChaCha20 written in the script, independent of the Rust core; the specification is in README.md §3.4. Lowercase hex without 0x. The Rust core must reproduce `names` by sealing with the given nonce, open them, and reject `openFailures`.",
  constants: { domain: NAME_DOMAIN, length: 104, nonceLength: 24, paddedNameLength: 64, tagLength: 16 },
  key: hex(nameKey),
  slotNul: hex(slotNul),
  names,
  openFailures,
  sealFailures: { tooLong: "x".repeat(65), empty: "", withNul: "a\u0000b" },
});
console.log(CHECK ? (process.exitCode ? "vectors DIFFER" : "vectors up to date") : "wrote keys.json and name-cipher.json");
