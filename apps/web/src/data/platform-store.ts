/**
 * The Platform Portal's store.
 *
 * One store rather than four, because the portal is one screen with four
 * sections and every action it takes changes what at least two of them should
 * show — suspending an organization changes the list, the health figures and
 * the audit log. Splitting them would mean three refreshes to keep in step.
 *
 * The browser holds no authorization logic. Sections are rendered from the
 * permission list the server returned, which decides what to draw; what may
 * actually be done is decided again on every request by the guard. A portal
 * that drew every button would be a usability bug, not a security one.
 */
import { ApiError } from "../api/client.js";
import type {
  IssuedCredentials,
  NewOrganization,
  OrganizationSummary,
  PlatformApi,
  PlatformAuditEvent,
  PlatformHealth,
  PlatformUser,
} from "./platform-api.js";

export type PlatformStatus = "unknown" | "signed_out" | "signed_in";

export interface PlatformSnapshot {
  readonly status: PlatformStatus;
  readonly user: PlatformUser | null;
  readonly organizations: readonly OrganizationSummary[];
  readonly events: readonly PlatformAuditEvent[];
  readonly health: PlatformHealth | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export type PlatformActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export class PlatformStore {
  #status: PlatformStatus = "unknown";
  #user: PlatformUser | null = null;
  #organizations: OrganizationSummary[] = [];
  #events: PlatformAuditEvent[] = [];
  #health: PlatformHealth | null = null;
  #loading = false;
  #error: string | null = null;

  readonly #listeners = new Set<() => void>();
  #snapshot: PlatformSnapshot = this.#build();

  constructor(private readonly api: PlatformApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = (): PlatformSnapshot => this.#snapshot;

  #build(): PlatformSnapshot {
    return {
      status: this.#status,
      user: this.#user,
      organizations: this.#organizations,
      events: this.#events,
      health: this.#health,
      loading: this.#loading,
      error: this.#error,
    };
  }

  #commit(): void {
    this.#snapshot = this.#build();
    for (const listener of [...this.#listeners]) listener();
  }

  /** Resolves the session the cookie already carries, if there is one. */
  async load(): Promise<void> {
    try {
      const { user } = await this.api.me();
      this.#user = user;
      this.#status = "signed_in";
      this.#commit();
      await this.refresh();
    } catch {
      this.#status = "signed_out";
      this.#user = null;
      this.#commit();
    }
  }

  async signIn(username: string, password: string): Promise<PlatformActionResult> {
    try {
      const { user } = await this.api.signIn(username, password);
      this.#user = user;
      this.#status = "signed_in";
      this.#commit();
      await this.refresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageFor(error, "Could not sign in. Try again.") };
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.api.signOut();
    } finally {
      this.#status = "signed_out";
      this.#user = null;
      this.#organizations = [];
      this.#events = [];
      this.#health = null;
      this.#commit();
    }
  }

  /**
   * Re-reads everything the portal shows.
   *
   * Called after every action rather than patching the list in place. The
   * server decides what an organization looks like after being suspended, and
   * a client that predicted it would be a second implementation of the same
   * rule — the one that disagrees the first time suspension does anything more
   * than set a flag.
   */
  async refresh(): Promise<void> {
    this.#loading = true;
    this.#error = null;
    this.#commit();

    try {
      const [organizations, events, health] = await Promise.all([
        this.api.organizations(),
        this.api.audit(),
        this.api.health(),
      ]);
      this.#organizations = organizations.organizations;
      this.#events = events.events;
      this.#health = health;
    } catch (error) {
      this.#error = messageFor(error, "Could not load the platform.");
    } finally {
      this.#loading = false;
      this.#commit();
    }
  }

  async create(
    input: NewOrganization,
  ): Promise<
    { ok: true; administrator: IssuedCredentials } | { ok: false; message: string }
  > {
    try {
      const created = await this.api.createOrganization(input);
      await this.refresh();
      return { ok: true, administrator: created.administrator };
    } catch (error) {
      return { ok: false, message: messageFor(error, "Could not create the organization.") };
    }
  }

  async suspend(id: string, reason: string): Promise<PlatformActionResult> {
    return this.#act(() => this.api.suspend(id, reason), "Could not suspend the organization.");
  }

  async reactivate(id: string): Promise<PlatformActionResult> {
    return this.#act(() => this.api.reactivate(id), "Could not reactivate the organization.");
  }

  async resetAdministrator(
    id: string,
    username: string,
  ): Promise<
    { ok: true; administrator: IssuedCredentials } | { ok: false; message: string }
  > {
    try {
      const { administrator } = await this.api.resetAdministrator(id, username);
      await this.refresh();
      return { ok: true, administrator };
    } catch (error) {
      return { ok: false, message: messageFor(error, "Could not reset that administrator.") };
    }
  }

  async #act(run: () => Promise<unknown>, fallback: string): Promise<PlatformActionResult> {
    try {
      await run();
      await this.refresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageFor(error, fallback) };
    }
  }

  can(permission: string): boolean {
    return this.#user?.permissions.includes(permission) ?? false;
  }
}

/**
 * The server's message when it sent one.
 *
 * A refusal explains itself — which permission was missing, which code was
 * taken — and replacing that with a generic string would throw away the only
 * part of the response the administrator can act on.
 */
function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const problems = error.problems;
    if (problems !== undefined && problems.length > 0) return problems.join(" ");
    return error.message;
  }
  return fallback;
}
