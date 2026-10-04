# The test container for vix3l-zcode-tools.
#
# The suite drives a real Chromium (the pill, the card, the chips and the
# dashboard are all verified as rendered pixels, not as strings), so the image
# carries Chromium and the fonts it needs. That is the whole reason this is a
# container: nobody should have to install a browser, a matching Node, or any
# library onto their machine to check a plugin — `docker compose -f
# tests/docker/compose.yml run --rm tests` is the entire setup.
#
# The plugins themselves have no dependencies at all, so the only npm package in
# here is Playwright (used as a browser driver). The image is therefore small
# and its dependency surface is one pinned package.
FROM node:24-bookworm-slim

# Chromium and the shared libraries Playwright's browser build needs, plus a
# font package (a container with no fonts renders text at zero width, which
# would make every layout assertion meaningless).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libudev1 \
      libvulkan1 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
      zip \
    && rm -rf /var/lib/apt/lists/*

# Chromium's sandbox needs privileges containers do not have; the suite passes
# --no-sandbox everywhere (see tests/lib/browser.mjs and tests/lib/cdp.mjs).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Install the one dev dependency first, so the layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# The pinned browser build. Reinstalling only happens if the lockfile changes.
RUN npx playwright install --with-deps chromium \
    && npx playwright install chromium-headless-shell

# The source under test. Everything else is mounted or ignored.
COPY . .

# A non-root user: Chromium refuses to run as root in some configurations, and
# the tests write temp databases, so an unprivileged owner is the right default.
# The official Node image already has a "node" user at uid 1000, so reuse it
# rather than adding a conflicting one.
RUN mkdir -p /app/tests/.artifacts \
    && chown -R node:node /app /ms-playwright
USER node
ENV HOME=/home/node

# `node --test` is the runner; --test-concurrency=1 keeps the browser tests
# (which each launch a Chromium) from fighting over memory. The test path is a
# QUOTED GLOB: `node --test` does not accept a bare directory argument here (it
# resolves it as a module specifier and fails with MODULE_NOT_FOUND), whereas a
# glob is expanded by the runner itself and discovers every tier.
CMD ["node", "--test", "--test-concurrency=1", "--test-timeout=60000", "tests/**/*.test.mjs"]
