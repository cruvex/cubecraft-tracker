FROM rust:slim AS build

RUN rustup target add x86_64-unknown-linux-musl && \
    apt update && \
    apt install -y musl-tools musl-dev

WORKDIR /app/api

COPY api/migrations ./migrations
COPY api/games.json .
COPY api/src ./src
COPY api/Cargo.lock .
COPY api/Cargo.toml .

RUN cargo build --target x86_64-unknown-linux-musl --release

FROM scratch

COPY --from=build /app/api/target/x86_64-unknown-linux-musl/release/cubecraft-api /app

EXPOSE 8080

ENTRYPOINT ["/app"]
