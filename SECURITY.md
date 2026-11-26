# Security

## Important notice

NightMail is hackathon software under active development. It runs on a local test network (devnet) and on Midnight's **preprod** test network. It is provided as is, without any warranty. **Do not use it with real funds or for important mail.** The tokens it uses (test NIGHT and DUST, and the demo's TestToken) have no value.

## Supported versions

Only the latest version of the `main` branch is supported. NightMail is alpha software built for a hackathon, so there are no older releases that receive fixes.

## How to report a vulnerability

Report it **privately**, never in a public issue:

1. Open the **Security** tab of this repository on GitHub.
2. Click **Report a vulnerability** (GitHub Security Advisories).
3. Describe the problem, the affected version or commit and, if you can, the steps to reproduce it.

We will answer in that same private advisory. Please do not publish the details until there is a fix or we have agreed on a date with you.

## Scope

In scope:

- **Desktop app** (`apps/desktop`): the Rust core, the interface and the Midnight helper process (`apps/midnight-sidecar`). For example: leaks of the seed phrase or of keys, mail that is decrypted or shown where it should not be, and links or content of an email that escape the reader.
- **Mail server** (`apps/server`): SMTP reception, the mailbox API, the plan issuer and the relayer.
- **Payer** (`apps/server/src/bin/operator-wallet.ts`): the process that holds the operator's wallet.
- **Contracts** (`contracts/`): the address registry and the test token.
- The project's own libraries in `packages/`.

Out of scope:

- Limits the project already states (for example, that the operator sees the plans it issues, or that without Tor the operator can see the IP address of connections).
- Vulnerabilities in third-party dependencies that do not affect NightMail in a concrete way. Report those to their project.
- Volume-based denial-of-service attacks against the test network.
