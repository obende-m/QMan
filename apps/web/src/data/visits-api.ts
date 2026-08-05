/**
 * The visit API, as the browser sees it.
 *
 * A typed surface over the transport, mirroring `configuration-api.ts`. It
 * knows paths and shapes and nothing else — which action is legal from which
 * status is the aggregate's decision, made on the server, and a copy of the
 * transition table here would be a second opinion.
 *
 * Every action returns the visit that resulted, so a store replaces what it
 * holds with what the server committed rather than re-fetching and hoping. A
 * re-fetch would open a window in which another workstation's action is read as
 * the effect of this one.
 */
import type { VisitWire } from "@qman/domain";
import type { ApiClient } from "../api/client.js";

export interface VisitResponse {
  readonly visit: { readonly state: VisitWire };
}

export interface VisitListResponse {
  readonly visits: ReadonlyArray<{ readonly state: VisitWire }>;
}

export interface AdmissionResponse extends VisitResponse {
  /** Returned once, printed into the ticket's QR code. */
  readonly trackingToken: string;
}

export class VisitsApi {
  constructor(private readonly client: ApiClient) {}

  listForBranch(branchId: string): Promise<VisitListResponse> {
    return this.client.get<VisitListResponse>(
      `/api/v1/branches/${encodeURIComponent(branchId)}/visits`,
    );
  }

  listForStation(stationId: string): Promise<VisitListResponse> {
    return this.client.get<VisitListResponse>(
      `/api/v1/stations/${encodeURIComponent(stationId)}/queue`,
    );
  }

  admit(
    patient: { patientName: string; hospitalNumber?: string; phone?: string; priority?: string },
    idempotencyKey: string,
  ): Promise<AdmissionResponse> {
    return this.client.post<AdmissionResponse>("/api/v1/visits", patient, idempotencyKey);
  }

  call(visitId: string, key: string): Promise<VisitResponse> {
    return this.act(visitId, "call", key);
  }

  recall(visitId: string, key: string): Promise<VisitResponse> {
    return this.act(visitId, "recall", key);
  }

  start(visitId: string, key: string): Promise<VisitResponse> {
    return this.act(visitId, "start", key);
  }

  skip(visitId: string, key: string): Promise<VisitResponse> {
    return this.act(visitId, "skip", key);
  }

  complete(visitId: string, key: string): Promise<VisitResponse> {
    return this.act(visitId, "complete", key);
  }

  cancel(visitId: string, key: string): Promise<VisitResponse> {
    return this.act(visitId, "cancel", key);
  }

  /**
   * `followedWorkflow` is sent explicitly rather than inferred.
   *
   * The server refuses an off-workflow route without the permission for it, and
   * it can only do that if the caller says which kind of route this is. Letting
   * the server guess from the destination would make every unusual-but-legal
   * route look like an override.
   */
  route(
    visitId: string,
    stationId: string,
    followedWorkflow: boolean,
    key: string,
  ): Promise<VisitResponse> {
    return this.client.post<VisitResponse>(
      `/api/v1/visits/${encodeURIComponent(visitId)}/route`,
      { stationId, followedWorkflow },
      key,
    );
  }

  private act(visitId: string, action: string, key: string): Promise<VisitResponse> {
    return this.client.post<VisitResponse>(
      `/api/v1/visits/${encodeURIComponent(visitId)}/${action}`,
      undefined,
      key,
    );
  }
}
