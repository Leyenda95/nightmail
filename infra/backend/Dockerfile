# syntax=docker/dockerfile:1.29.0@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# NightMail backend image: Node 24, the contracts compiled with their ZK keys, and the operator server
# (mail server, issuer, relayer, payer and the deploy command). Built by docker-compose.yml next to this
# file, with the repository root as context. Dockerfile.dockerignore limits what is sent to the build.

# Node 24.12.0 (.nvmrc), pinned by digest.
ARG NODE_IMAGE=node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

# ---------- Contracts, compiled with the compiler pinned in contracts/package.json ----------
FROM ${NODE_IMAGE} AS contracts
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
# The Compact CLI, a fixed release checked against its SHA-256 (from the release's own .sha256 files).
# It then fetches the compiler pinned in contracts/package.json.
ARG COMPACT_CLI_VERSION=0.5.3
ARG COMPACT_CLI_SHA256_AMD64=dfaaeccefe0d77095293208171bcefc48529b8d094dada3670b0e0684932d605
ARG COMPACT_CLI_SHA256_ARM64=8f5a54a15727eb3c93fcf0567ed1a49478682c23e0dd59a215fa6a3dadfc41d3
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) target=x86_64-unknown-linux-musl; sum="$COMPACT_CLI_SHA256_AMD64" ;; \
      arm64) target=aarch64-unknown-linux-musl; sum="$COMPACT_CLI_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac; \
    curl --proto '=https' --tlsv1.2 -fLsS -o /tmp/compact.tar.xz \
      "https://github.com/midnightntwrk/compact/releases/download/compact-v${COMPACT_CLI_VERSION}/compact-${target}.tar.xz"; \
    echo "$sum  /tmp/compact.tar.xz" | sha256sum -c -; \
    mkdir /tmp/compact; \
    tar -xJf /tmp/compact.tar.xz -C /tmp/compact; \
    install -m 0755 "$(find /tmp/compact -type f -name compact | head -n 1)" /usr/local/bin/compact; \
    rm -rf /tmp/compact /tmp/compact.tar.xz; \
    compact --version
WORKDIR /app/contracts
COPY contracts/package.json ./
# The exact compiler version from contracts/package.json. compact update asks the GitHub API, which allows
# 60 requests per hour without a token.
RUN set -eu; \
    v="$(node -p "require('./package.json').config.compact.replace(/^[+]/, '')")"; \
    case "$v" in \
      [0-9]*.[0-9]*.[0-9]*) ;; \
      *) echo "ERROR: contracts/package.json must pin an exact compiler version (x.y.z), it has $v"; exit 1 ;; \
    esac; \
    if ! compact update "$v"; then \
      echo "ERROR: could not fetch the Compact compiler $v. If GitHub answered with a rate limit"; \
      echo "(60 requests per hour without a token), wait up to an hour and run the demo again."; \
      exit 1; \
    fi; \
    compact compile "+$v" --version
COPY contracts/src ./src
RUN npm run compile

# ---------- Dependencies, without dev dependencies ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Every workspace's package.json, so that npm ci accepts the lockfile.
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/midnight-sidecar/package.json apps/midnight-sidecar/
COPY apps/server/package.json apps/server/
COPY contracts/package.json contracts/
COPY packages/core-ts/package.json packages/core-ts/
COPY packages/midnight/package.json packages/midnight/
COPY tools/demo-mailer/package.json tools/demo-mailer/
COPY tools/demo-seed/package.json tools/demo-seed/
# Only the backend's workspaces: the server, the two packages it uses and the contracts.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      -w apps/server -w packages/midnight -w packages/core-ts -w contracts

# ---------- Runtime ----------
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=deps /app ./
COPY packages/core-ts/src packages/core-ts/src
COPY packages/midnight/src packages/midnight/src
COPY apps/server/src apps/server/src
COPY --from=contracts /app/contracts/managed contracts/managed
COPY infra/backend/deploy.sh infra/backend/healthcheck.mjs infra/backend/receipt-key.mjs infra/backend/
# Mount points of the data volumes. A new volume takes this owner and mode (0700): the operator
# folder holds private keys, and the server refuses to use it if others can read it.
RUN mkdir -p .data/operator .data/server \
 && chown node:node .data .data/operator .data/server \
 && chmod 700 .data .data/operator .data/server
USER node
ENV NODE_ENV=production
