import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

const REPO = "cruvex/cubecraft-tracker";
const REGION = "europe-west4-drams3a";
const API_PORT = 8080;

export default defineRailway((ctx) => {
  const isProd = ctx.environment === "production";

  const source = github(REPO, { branch: "main", rootDirectory: "/" });

  const db = postgres("Postgres", { region: REGION });
  // The TCP proxy is how anything outside Railway reaches the database.
  db.networking = {
    privateNetworkEndpoint: "postgres",
    tcpProxies: { "5432": {} },
  };

  const dbVolume = volume("postgres-volume", {
    allowOnlineResize: true,
    region: REGION,
    sizeMB: 5000,
  });

  const scraperVolume = volume("scraper-volume", {
    allowOnlineResize: true,
    region: REGION,
    sizeMB: 5000,
  });

  const api = service("api", {
    source,
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "/api/Dockerfile",
      watchPatterns: ["/api/**"],
    },
    preDeploy: "bun run migrate",
    start: "bun run start",
    healthcheck: "/api/healthz",
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
    },
  });

  // Written out as a reference because api.env.RAILWAY_PRIVATE_DOMAIN is an object, not a string.
  const apiUrl = "${{" + api.name + ".RAILWAY_PRIVATE_DOMAIN}}:" + API_PORT;

  const scraper = service("scraper", {
    source,
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "/scraper/Dockerfile",
      watchPatterns: ["/scraper/**"],
    },
    healthcheck: "/healthz",
    // Holds the Microsoft sign-in, so a redeploy does not need a new one.
    volumeMounts: { "/data/auth": scraperVolume },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      CUBEPANION_API_KEY: preserve(),
      CUBEPANION_SUBMITTER_UUID: preserve(),
      DISCORD_WEBHOOK_URL: preserve(),
      MC_AUTH_DIR: preserve(),
      MC_USERNAME: preserve(),
      RAILWAY_RUN_UID: preserve()
    },
  });

  const dashboard = service("dashboard", {
    source,
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "/caddy/Dockerfile",
      watchPatterns: ["/caddy/**", "/dashboard/**"],
    },
    // Domains are globally unique, so another environment would take it off production.
    domains: isProd ? [{ domain: "cubecraftplus.net", port: 80 }] : undefined,
    env: {
      BACKEND_URL: apiUrl,
    },
  });

  const bot = service("bot", {
    source: github(REPO, { branch: "feat/discord-bot" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "/bot/Dockerfile",
      watchPatterns: ["/bot/**"],
    },
    env: {
      API_URL: apiUrl,
      DISCORD_TOKEN: preserve(),
    },
  });

  return project("CubeCraft+", {
    resources: [db, dbVolume, scraperVolume, api, scraper, dashboard, bot],
  });
});
