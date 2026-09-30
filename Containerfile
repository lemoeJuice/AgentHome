ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates git python3 make g++ nftables \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY src/runtime/principal-exec.c /tmp/principal-exec.c
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/agent-home-principal-exec /tmp/principal-exec.c \
  && chmod 755 /usr/local/bin/agent-home-principal-exec \
  && useradd --create-home --uid 10001 agent \
  && mkdir -p /state /cache /scratch /run/agent-home \
  && chmod 711 /state \
  && chmod 700 /cache /scratch /run/agent-home

RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/cli.js "$@"' > /usr/local/bin/agent-home \
  && chmod 755 /usr/local/bin/agent-home

ENV HOME=/root \
    PI_CODING_AGENT_DIR=/state/model/pi/agent \
    PATH=/state/pi/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    XDG_CACHE_HOME=/cache \
    TMPDIR=/scratch/tmp \
    AGENT_HOME_STATE=/state

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["supervise"]
