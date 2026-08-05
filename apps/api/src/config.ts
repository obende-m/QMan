/**
 * Configuration.
 *
 * Read once, validated once, at startup. A server that starts successfully and
 * fails on the first sign-in because a variable was missing has moved the
 * failure from the deployment — where someone is watching — to the clinic,
 * where nobody can fix it.
 *
 * Every value comes from the environment. Nothing is read from a file in the
 * repository, and nothing has a default that would be unsafe in production.
 */
import type { LogLevel } from "./logging.js";

export interface Config {
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
  readonly poolSize: number;
  readonly host: string;
  readonly port: number;
  readonly hospitalId: string;
  readonly logLevel: LogLevel;
  readonly secureCookies: boolean;
  readonly allowedOrigins: readonly string[];
  readonly production: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Where Vite serves the three surfaces from, in development only.
 *
 * A convenience that exists so a developer does not have to configure CORS
 * before the application will start. It is never reachable in production, where
 * the absence of QMAN_ALLOWED_ORIGINS is an error rather than a fallback —
 * a permissive default is a control that most deployments would not have.
 */
const DEVELOPMENT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
];

function required(env: NodeJS.ProcessEnv, key: string, hint: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${key} is not set. ${hint}`);
  }
  return value.trim();
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${key} must be a positive whole number, not "${raw}".`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new ConfigurationError(`${key} must be true or false, not "${raw}".`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = required(
    env,
    "DATABASE_URL",
    "It is the PostgreSQL connection string, for example postgres://user:password@host:5432/qman.",
  );

  const hospitalId = required(
    env,
    "QMAN_HOSPITAL_ID",
    "It is the id of the hospital this server serves. Every request is scoped to it.",
  );

  const level = (env["LOG_LEVEL"] ?? "info").trim().toLowerCase();
  if (!LOG_LEVELS.includes(level as LogLevel)) {
    throw new ConfigurationError(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, not "${level}".`,
    );
  }

  /**
   * Production is the default posture, and development is the exception that
   * has to be asked for.
   *
   * The other way round — assuming development unless told otherwise — means a
   * deployment that forgot to set NODE_ENV runs with development's conveniences
   * enabled, and every one of those conveniences is a weakened control.
   */
  const production = (env["NODE_ENV"] ?? "production").trim() !== "development";

  /**
   * Secure cookies default to on in production, off in development.
   *
   * A Secure cookie is never sent over plain HTTP, so `http://localhost` needs
   * it off or sign-in silently fails. In production it is not merely a default
   * but a floor: a deployment that turned it off would issue session cookies
   * that travel in the clear, and that is a refusal to start rather than a
   * warning nobody reads.
   */
  const secureCookies = boolean(env, "QMAN_SECURE_COOKIES", production);
  if (production && !secureCookies) {
    throw new ConfigurationError(
      "QMAN_SECURE_COOKIES is false in production. Session cookies would be sent over plain HTTP. " +
        "Set NODE_ENV=development if this is a local machine.",
    );
  }

  /**
   * Origins allowed to make state-changing requests — where the three QMan
   * surfaces are served from.
   *
   * Required, with no default. A default of "any origin" would disable CSRF
   * protection for every deployment that did not know to set it, and a control
   * that is off unless configured is a control most deployments do not have.
   * Each entry is parsed, so a trailing slash or a path is rejected here rather
   * than silently never matching an Origin header.
   */
  const configuredOrigins = env["QMAN_ALLOWED_ORIGINS"];
  const haveOrigins =
    typeof configuredOrigins === "string" && configuredOrigins.trim() !== "";

  if (production && !haveOrigins) {
    throw new ConfigurationError(
      "QMAN_ALLOWED_ORIGINS is not set. It is the comma-separated list of origins the web app is " +
        "served from, for example https://qman.hospital.example. There is no default in production.",
    );
  }

  const origins = (
    haveOrigins ? configuredOrigins : DEVELOPMENT_ORIGINS.join(",")
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const allowedOrigins = origins.map((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ConfigurationError(
        `QMAN_ALLOWED_ORIGINS contains "${value}", which is not a URL. Use scheme://host[:port].`,
      );
    }
    if (parsed.origin !== value.replace(/\/$/, "")) {
      throw new ConfigurationError(
        `QMAN_ALLOWED_ORIGINS contains "${value}". Give an origin only — "${parsed.origin}" — with no path or trailing slash.`,
      );
    }
    return parsed.origin;
  });

  return {
    allowedOrigins,
    production,
    databaseUrl,
    // Most managed providers require TLS; a server on the hospital's own LAN
    // typically has none configured.
    databaseSsl: boolean(env, "DATABASE_SSL", !databaseUrl.includes("localhost")),
    poolSize: integer(env, "DATABASE_POOL_SIZE", 10),
    host: (env["HOST"] ?? "0.0.0.0").trim(),
    port: integer(env, "PORT", 3001),
    hospitalId,
    logLevel: level as LogLevel,
    secureCookies,
  };
}
