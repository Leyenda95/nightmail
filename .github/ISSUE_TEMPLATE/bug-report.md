---
name: Bug report
about: Something in NightMail does not work as it should
title: ''
labels: bug
assignees: ''
---

<!-- Security problems (leaked keys or seed phrase, mail shown where it should not be, and similar) go to the Security tab of this repository, never to a public issue. See SECURITY.md. -->

### What happened

<!-- A clear description of the problem. Screenshots help. -->

### Steps to reproduce

1.
2.
3.

### What you expected

### Your system

- OS (and WSL version if you use it):
- How you run it (`npm run demo`, `tools/dev/up.sh` and `window.sh` on Linux or WSL, or the native Windows app with `build.ps1` and `window.ps1`):
- Network (local network `undeployed`, or preprod for the server and payer):
- App version or commit (`git rev-parse --short HEAD`):

### Logs

<!--
The tools/dev scripts write their logs to .data/dev/ in your copy of the repository:
- payer.log and server.log (payer and mail server, always in the Linux or WSL copy)
- window-<folder>.log (the app window; on native Windows also window-<folder>.err.log)
- build.log (the app build)
With the native Windows app, the window and build logs are in .data\dev\ of the Windows copy, and payer.log and server.log in the WSL copy.
Paste only the relevant lines. Remove anything private (seed phrases, passwords, keys, the Blockfrost project id BLOCKFROST_PROJECT_ID from .env, email addresses) before posting.
-->

```
```
