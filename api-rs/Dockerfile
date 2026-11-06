# Build context is the repo root, as the migrations still live in api/.
FROM rust:slim AS build

RUN rustup target add x86_64-unknown-linux-musl && \
    apt update && \
    apt install -y musl-tools musl-dev

WORKDIR /app/api-rs

COPY api/migrations ../api/migrations
COPY api-rs/games.json .
COPY api-rs/src ./src
COPY api-rs/Cargo.lock .
COPY api-rs/Cargo.toml .

RUN cargo build --target x86_64-unknown-linux-musl --release

FROM scratch

COPY --from=build /app/api-rs/target/x86_64-unknown-linux-musl/release/cubecraft-api /app

EXPOSE 8080

ENTRYPOINT ["/app"]
