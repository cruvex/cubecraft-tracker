import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mineflayer, { type Bot } from "mineflayer";

const host = process.env.CUBECRAFT_HOST || "play.cubecraft.net";
const port = Number(process.env.CUBECRAFT_PORT || 25565);

// Pinned rather than detected: the image ships this one version's protocol data
// and nothing else (see the Dockerfile), and detecting costs an extra ping.
export const minecraftVersion = process.env.MC_VERSION || "26.1";

// Microsoft tokens are cached here after the first sign-in. On Railway this has
// to be a volume, or every deploy asks for a fresh device-code sign-in.
const authDir = process.env.MC_AUTH_DIR || join(process.cwd(), ".auth");

const loginTimeoutMs = 30_000;

// The scrape only ever uses menus. Storing the lobby's chunks and running
// physics over them is most of mineflayer's memory, so everything about the
// world is left out. What stays: login and settings (game, settings, kick,
// resource_pack), the player (entities, health, which emits spawn), chat, and
// the inventory and windows.
const unusedPlugins = [
  "anvil", "bed", "block_actions", "blocks", "book", "boss_bar", "breath",
  "chest", "command_block", "craft", "creative", "digging", "enchantment_table",
  "experience", "explosion", "fishing", "furnace", "generic_place", "particle",
  "physics", "place_block", "place_entity", "rain", "ray_trace", "scoreboard",
  "sound", "spawn_point", "tablist", "team", "time", "title", "villager",
];

// How long the lobby may take to finish setting the player up after spawn.
const lobbyTimeoutMs = 5_000;

/**
 * Log in and wait until the lobby will take a click. Rejects on kick, error,
 * disconnect or abort before then. The caller owns the bot afterwards and must
 * quit it.
 */
export function connect(signal: AbortSignal): Promise<Bot> {
  const username = process.env.MC_USERNAME;
  if (!username) return Promise.reject(new Error("MC_USERNAME is not set"));

  const token = seedTokenCache(username);
  if (token !== reportedToken) {
    reportedToken = token;
    console.log(`[cubecraft] Microsoft token: ${tokenMessages[token]}`);
  }

  let deadline: ReturnType<typeof setTimeout> | undefined;

  const bot = mineflayer.createBot({
    host,
    port,
    username,
    version: minecraftVersion,
    auth: "microsoft",
    brand: "vanilla",
    profilesFolder: authDir,
    plugins: Object.fromEntries(unusedPlugins.map((name) => [name, false])),
    // Only reached when the token cache is empty or expired. Signing in takes
    // longer than logging in, so from here only the task's timeout applies.
    onMsaCode: (data) => {
      clearTimeout(deadline);
      console.warn(
        `[cubecraft] Microsoft sign-in needed: open ${data.verification_uri} and enter ${data.user_code}`,
      );
    },
  });

  sendBrandDuringConfiguration(bot);
  fixResourcePackUuid(bot);
  bot.on("resourcePack", () => {
    // mineflayer answers packs offered during configuration itself.
    if (bot._client.state !== "configuration") bot.acceptResourcePack();
  });

  return new Promise((resolve, reject) => {
    deadline = setTimeout(
      () => fail(new Error(`Not in the lobby within ${loginTimeoutMs / 1000}s`)),
      loginTimeoutMs,
    );

    function onKicked(reason: string) {
      fail(new Error(`Kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`));
    }
    function onError(err: Error) {
      fail(err);
    }
    function onEnd(reason: string) {
      fail(new Error(`Disconnected before reaching the lobby: ${reason}`));
    }
    function onAbort() {
      fail(new Error("Aborted while connecting"));
    }

    function cleanup() {
      clearTimeout(deadline);
      bot.removeListener("kicked", onKicked);
      bot.removeListener("error", onError);
      bot.removeListener("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    }
    function fail(err: Error) {
      cleanup();
      bot.quit();
      reject(err);
    }

    bot.on("kicked", onKicked);
    bot.on("error", onError);
    bot.on("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });

    bot.once("spawn", async () => {
      // The lobby ignores clicks until it is done, so waiting is part of connecting.
      await waitForLobby(bot);
      cleanup();
      resolve(bot);
    });
  });
}

type TokenSource = "cached" | "seeded" | "missing";

const tokenMessages: Record<TokenSource, string> = {
  cached: `using the cache in ${authDir}`,
  seeded: `cache was empty, seeded it from MC_REFRESH_TOKEN`,
  missing: `cache is empty and MC_REFRESH_TOKEN is not set, a device-code sign-in will be needed`,
};

// Logged when it changes rather than every run.
let reportedToken: TokenSource | null = null;

/**
 * Seed an empty token cache from MC_REFRESH_TOKEN.
 *
 * The Microsoft refresh token is the only secret the chain needs: given a cache
 * holding just that, prismarine-auth refreshes the access token straight away
 * and derives the Xbox and Minecraft tokens from it. Microsoft hands out a new
 * refresh token on every refresh, which prismarine-auth writes back to the
 * cache, so the seed is only for a cache that has nothing yet. From then on the
 * cache (a volume, so it outlives deploys) holds the current token, and a stale
 * seed in the environment is never read again.
 *
 * The value is `token.refresh_token` from a working `*_live-cache.json`.
 */
function seedTokenCache(username: string): TokenSource {
  // prismarine-auth's own file name: the first six hex characters of the
  // username's sha1, then the auth flow, which is "live" for mineflayer.
  const hash = createHash("sha1").update(username, "binary").digest("hex").slice(0, 6);
  const file = join(authDir, `${hash}_live-cache.json`);

  try {
    if (JSON.parse(readFileSync(file, "utf8")).token?.refresh_token) return "cached";
  } catch {
    // Missing or unreadable: treated as empty, same as prismarine-auth does.
  }

  const seed = process.env.MC_REFRESH_TOKEN;
  if (!seed) return "missing";

  // With no access token, and obtainedOn in 1970, the first login refreshes.
  mkdirSync(authDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ token: { refresh_token: seed, obtainedOn: 0, expires_in: 0 } }));
  return "seeded";
}

/**
 * Wait until the lobby will take a click.
 *
 * The hotbar is filled almost at once, but the lobby ignores clicks until it
 * has finished setting the player up, and the last thing it does is select
 * hotbar slot 4. The login also selects a slot, always 0, and the hotbar can
 * look filled at that point only to be wiped a moment later, so the signal is
 * specifically the server moving the selection off slot 0. On timeout this
 * carries on anyway; opening the Games menu retries if the click is dropped.
 */
function waitForLobby(bot: Bot): Promise<void> {
  return new Promise((resolve) => {
    const deadline = setTimeout(done, lobbyTimeoutMs);
    function onSelect(packet: { slot: number }) {
      if (packet.slot !== 0) done();
    }
    function done() {
      clearTimeout(deadline);
      bot._client.removeListener("held_item_slot", onSelect);
      resolve();
    }
    bot._client.on("held_item_slot", onSelect);
  });
}

/**
 * Send minecraft:brand during the configuration phase.
 *
 * The vanilla client does this on entering configuration. mineflayer only sends
 * it from the play-phase login handler, which deadlocks against a server that
 * withholds finish_configuration until it has seen a brand, as CubeCraft does.
 */
function sendBrandDuringConfiguration(bot: Bot) {
  let sent = false;
  bot._client.on("packet", (_data, meta) => {
    if (sent || meta.state !== "configuration") return;
    sent = true;
    bot._client.write("custom_payload", {
      channel: "minecraft:brand",
      data: prefixedString("vanilla"),
    });
  });
}

/**
 * Fix the resource-pack acknowledgement uuid.
 *
 * mineflayer passes a uuid object to resource_pack_receive, which the
 * serialiser turns into sixteen zero bytes. CubeCraft then waits for an
 * acknowledgement of the pack it actually sent, and because the pack is forced
 * it never finishes configuration. Coerced at the write layer, since plugins are
 * injected after createBot returns and replacing their listener does nothing.
 */
function fixResourcePackUuid(bot: Bot) {
  const client = bot._client;
  const write = client.write.bind(client);
  client.write = (name: string, params: any) => {
    if (name === "resource_pack_receive" && params?.uuid && typeof params.uuid !== "string") {
      params = { ...params, uuid: String(params.uuid) };
    }
    return write(name, params);
  };
}

/** varint-length-prefixed UTF-8, the wire format of a brand payload. */
function prefixedString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const varint: number[] = [];
  let n = bytes.length;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    varint.push(byte);
  } while (n);
  return Buffer.concat([Buffer.from(varint), bytes]);
}
