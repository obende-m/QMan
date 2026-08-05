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
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

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
   * Secure cookies default to on, and turning them off has to be deliberate.
   * A Secure cookie is never sent over plain HTTP, so local development needs
   * this off — but a production deployment that forgot to set it would then be
   * issuing session cookies that travel in the clear.
   */
  const secureCookies = boolean(env, "QMAN_SECURE_COOKIES", true);

  return {
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
