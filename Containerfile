FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN useradd --create-home --uid 10001 agent \
  && mkdir -p /state /cache /scratch /run/agent-home \
  && chown -R agent:agent /app /state /cache /scratch /run/agent-home

RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/cli.js "$@"' > /usr/local/bin/agent-home \
  && chmod 755 /usr/local/bin/agent-home

USER agent
ENV HOME=/state/home \
    XDG_CONFIG_HOME=/state/home/.config \
    XDG_DATA_HOME=/state/home/.local/share \
    XDG_STATE_HOME=/state/home/.local/state \
    XDG_CACHE_HOME=/cache \
    TMPDIR=/scratch/tmp \
    AGENT_HOME_STATE=/state

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["runtime"]
