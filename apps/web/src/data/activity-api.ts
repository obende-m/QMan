/**
 * The event log, as the browser reads it.
 *
 * `GET /api/v1/events` returns the same staff projection the stream publishes,
 * so what comes back here goes through the same translation as live traffic.
 * History and live events are the same events at different ages.
 */
import type { ApiClient } from "../api/client.js";
import type { StreamEventLike } from "./operations-store.js";

export interface EventQueryOptions {
  readonly branchId?: string;
  readonly correlationId?: string;
  readonly limit?: number;
}

export class ActivityApi {
  constructor(private readonly client: ApiClient) {}

  read(options: EventQueryOptions = {}): Promise<{ events: StreamEventLike[] }> {
    const query = new URLSearchParams();
    if (options.branchId !== undefined) query.set("branchId", options.branchId);
    if (options.correlationId !== undefined) {
      query.set("correlationId", options.correlationId);
    }
    if (options.limit !== undefined) query.set("limit", String(options.limit));

    const suffix = query.toString();
    return this.client.get<{ events: StreamEventLike[] }>(
      `/api/v1/events${suffix === "" ? "" : `?${suffix}`}`,
    );
  }
}
