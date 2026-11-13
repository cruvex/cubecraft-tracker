-- Auth for the mod, and later the dashboard. Both end at an opaque bearer token in
-- auth_tokens; only how the holder got there differs.
--
-- No FK on player_uuid: there is no canonical players table, ign_history and
-- player_scores key off it the same way.

-- Steps 1-3 of the Mojang session-server handshake. The uuid the mod claims is
-- not stored, because the profile hasJoined returns is the authoritative answer.
CREATE TABLE auth_challenges (
    -- The nonce, passed to Mojang as serverId.
    server_id     text        PRIMARY KEY,
    -- hasJoined is keyed by username, not uuid.
    username      text        NOT NULL,
    -- server_id travels to Mojang in a query string and lands in access logs, so
    -- it is not enough on its own: verify also needs this second secret, which
    -- only ever moves between the mod and here.
    verifier_hash bytea       NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);

-- No index on expires_at here: rows live ~60s, and the write churn would cost
-- more than the sweep it saves.

-- One row per live credential. kind is the only thing separating a browser
-- session from a mod session; lookup and expiry are shared.
CREATE TABLE auth_tokens (
    id              uuid        PRIMARY KEY,
    -- SHA-256 of the token. A plain digest rather than bcrypt: the token is 256
    -- bits of randomness, so there is nothing to brute force.
    token_hash      bytea       NOT NULL UNIQUE,
    player_uuid     uuid        NOT NULL,
    kind            text        NOT NULL CHECK (kind IN ('web', 'mod')),
    -- How the row came to exist, so the signed-in-devices list can say.
    origin          text        NOT NULL
        CHECK (origin IN ('mod_direct', 'device_code', 'session_server')),
    -- Browser UA, or "CubeCraftPlus/1.4.0 (MC 26.2)".
    client          text,
    -- City resolved at insert. The IP itself is deliberately not kept.
    client_location text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    -- Slides forward on use, never past hard_expires_at. Equal to it for mod
    -- tokens, which do not slide: the mod re-runs the handshake on launch.
    expires_at      timestamptz NOT NULL,
    hard_expires_at timestamptz NOT NULL,

    CONSTRAINT auth_tokens_expiry_ordered CHECK (expires_at <= hard_expires_at)
);

CREATE INDEX idx_auth_tokens_player_uuid ON auth_tokens (player_uuid);
CREATE INDEX idx_auth_tokens_expires_at  ON auth_tokens (expires_at);
