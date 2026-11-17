# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM rust:1.93.1-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --locked

FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Tuwunel Admin" \
      org.opencontainers.image.description="Rust-powered Matrix Tuwunel administration console" \
      org.opencontainers.image.version="1.2.0" \
      org.opencontainers.image.source="https://github.com/utoptop/tuwunel-admin" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
RUN groupadd --gid 1000 admin && useradd --uid 1000 --gid admin --no-create-home admin \
    && mkdir /app/data && chown admin:admin /app/data
COPY --from=backend /app/target/release/tuwunel-admin /usr/local/bin/tuwunel-admin
COPY --from=frontend /app/dist ./dist
COPY config.example.toml ./config.toml
USER 1000:1000
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["tuwunel-admin", "--config", "/app/config.toml", "--health-check"]
ENTRYPOINT ["tuwunel-admin"]
CMD ["--config", "/app/config.toml"]
