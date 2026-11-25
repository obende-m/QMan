/**
 * The one-time bootstrap.
 *
 * Creates the first Platform Super Admin and nothing else. It exists for two
 * moments in a deployment's life: the first minutes of it, and the disaster in
 * which every platform credential has been lost.
 *
 * **It cannot create a hospital.** There is no argument, flag or environment
 * variable that would make it, and it holds no code that writes to `hospitals`.
 * Organizations are created through the Platform portal, by a signed-in
 * administrator, with an audit record naming who did it — a hospital that
 * appeared because of a shell command would have none of that.
 *
 * It refuses to run when a platform administrator already exists. That refusal
 * is the difference between a bootstrap and a back door: without it, anyone who
 * reached the server's shell could mint themselves an account holding every
 * platform permission, and the audit log would show an account creating itself.
 * `--recover` overrides it, and says so loudly in the platform audit log.
 */
import { migrate } from "@qman/persistence";
import {
  PostgresPlatformEventRepository,
  PostgresPlatformUserRepository,
} from "@qman/persistence";
import { ConfigurationError, loadConfig } from "./config.js";
import { connect } from "./database.js";
import { createLogger } from "./logging.js";
import { loadMigrations } from "./migrations.js";
import { hashPassword } from "./passwords.js";
import { generatePassword } from "./tokens.js";

export interface BootstrapOptions {
  readonly username: string;
  readonly displayName: string;
  readonly recover: boolean;
}

export function parseArguments(argv: readonly string[]): BootstrapOptions {
  const options = new Map<string, string>();
  let recover = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--recover") {
      recover = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const [name, inline] = argument.slice(2).split("=");
      options.set(name!, inline ?? argv[++index] ?? "");
    }
  }

  const username = (options.get("username") ?? "").trim();
  if (username === "") {
    throw new ConfigurationError(
      "Give a username: npm run bootstrap -w @qman/api -- --username <name>",
    );
  }

  return {
    username,
    displayName: (options.get("name") ?? username).trim(),
    recover,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(argv);
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const { db, close } = connect(config, logger);

  try {
    // The schema must be current before there is a table to write to. Running
    // migrations here means bootstrap works on a database that has only just
    // been created, which is the case it exists for.
    await migrate(db, loadMigrations());

    const users = new PostgresPlatformUserRepository(db);
    const existing = await users.count();

    if (existing > 0 && !options.recover) {
      throw new ConfigurationError(
        `A Platform Super Admin already exists (${existing} platform account(s)). ` +
          "Bootstrap creates the first one only. If every platform credential has been " +
          "lost, re-run with --recover, which is recorded in the platform audit log.",
      );
    }

    const password = generatePassword();
    const hashed = await hashPassword(password);
    const at = new Date();

    const id = await users.create(
      {
        username: options.username,
        displayName: options.displayName,
        passwordHash: hashed.hash,
        passwordSalt: hashed.salt,
        role: "super_admin",
        enabled: true,
      },
      at,
    );

    await new PostgresPlatformEventRepository(db).append({
      type: options.recover ? "platform.admin_recovered" : "platform.bootstrapped",
      // No actor: nobody was signed in. That is precisely what makes this event
      // worth keeping — an account that appeared without an authenticated
      // author is the one an auditor should be able to find.
      actorId: null,
      targetHospitalId: null,
      correlationId: null,
      occurredAt: at,
      payload: { username: options.username, recover: options.recover },
      summary: options.recover
        ? `Recovery bootstrap created the platform account ${options.username}.`
        : `Bootstrap created the first platform account, ${options.username}.`,
    });

    /*
     * Printed once, to stdout, and never stored in plaintext or written to the
     * log. The log is shipped somewhere and kept; this is meant to be read off
     * a terminal, used, and changed.
     */
    process.stdout.write(
      [
        "",
        "  Platform Super Admin created.",
        "",
        `    Username  ${options.username}`,
        `    Password  ${password}`,
        `    Id        ${id}`,
        "",
        "  This password is shown once and is not recoverable.",
        "  Sign in at /platform.html and create your first organization there.",
        "",
      ].join("\n"),
    );
  } finally {
    await close();
  }
}
