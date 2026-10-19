# Build from the repository root. Shared runtime: compiled code + locked production dependencies.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS build
WORKDIR /build
ARG ADI_CI_NPM_REGISTRY=https://registry.npmjs.org/
RUN npm install --global pnpm@10.33.0 --registry="$ADI_CI_NPM_REGISTRY"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc LICENSE NOTICE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt ./
COPY apps/api/package.json ./apps/api/
COPY apps/collector/package.json ./apps/collector/
COPY apps/worker/package.json ./apps/worker/
COPY apps/hook-client/package.json ./apps/hook-client/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/domain/package.json ./packages/domain/
COPY packages/storage/package.json ./packages/storage/
COPY packages/tsconfig/package.json ./packages/tsconfig/
RUN pnpm install --frozen-lockfile --registry="$ADI_CI_NPM_REGISTRY"
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY scripts/package-hook-client.mjs scripts/prepare-product-runtime.mjs ./scripts/
RUN pnpm -r --if-present build && node scripts/package-hook-client.mjs
FROM build AS runtime-files
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && CI=true pnpm --filter @adi/api... --filter @adi/collector... --filter @adi/worker... install --prod --frozen-lockfile --offline --registry="$ADI_CI_NPM_REGISTRY" \
 && node scripts/prepare-product-runtime.mjs /out/runtime

FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-files /out/runtime/ /app/
RUN mkdir -p /var/lib/adi-credentials && chown node:node /var/lib/adi-credentials && chmod 700 /var/lib/adi-credentials
USER node

FROM runtime AS api
ENV ADI_API_HOST=0.0.0.0 ADI_API_PORT=4180
EXPOSE 4180
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS collector
ENV ADI_COLLECTOR_HOST=0.0.0.0 ADI_COLLECTOR_PORT=4186 NODE_OPTIONS=--max-old-space-size=512
EXPOSE 4186
CMD ["node", "apps/collector/dist/main.js"]

FROM runtime AS worker
ENV NODE_OPTIONS=--max-old-space-size=256
CMD ["node", "apps/worker/dist/supervisor-main.js"]

FROM nginx:stable-alpine@sha256:985220252f3863977e468f611ef118ebd01421289dd86ee1ae99cb068c3bce2b AS web
COPY --from=build /build/apps/web/dist/ /usr/share/nginx/html/
COPY deploy/product/nginx.conf /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]

# Optional local reproduction of the Linux integration-job toolchain.
FROM build AS integration-test
COPY deploy/product/install-ci-postgres-client.sh /tmp/install-ci-postgres-client.sh
RUN CI=true sh /tmp/install-ci-postgres-client.sh
ENV CI=true
CMD ["pnpm", "test:integration"]
