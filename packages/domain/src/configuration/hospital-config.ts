import {
  validateQueueNumberConfig,
  type QueueNumberConfig,
} from "../queue/queue-number.js";
import { validateWorkflow, type Workflow } from "../workflow/workflow.js";
import {
  validateTicketTemplate,
  type TicketTemplate,
} from "../printing/ticket-template.js";
import type { StationSla } from "../analytics/operations.js";
import type { PatientNamePolicy } from "../privacy/patient-name.js";
import type { BranchId, HospitalId, StationId } from "../shared/ids.js";

/**
 * Hospital configuration.
 *
 * This is the type that turns QMan from software into a platform: everything a
 * hospital needs to describe itself — its stations, how each numbers its
 * queues, how patients flow between them, what appears on which screen — is
 * data, validated at edit time, with no code change and no deployment.
 *
 * It is defined in the domain rather than the admin UI because the API will
 * need to validate exactly the same shape when the portal posts it, and two
 * validators that must agree are one validator too many.
 */

export interface StationConfig {
  readonly id: StationId;
  readonly name: string;
  /** Short code used by the `{station}` queue-number token, e.g. "LAB". */
  readonly code: string;
  /** Where the station physically is. Shown to patients so they can walk there. */
  readonly room: string | null;
  /** Staff typically working this station; sizes wait estimates. */
  readonly staffing: number;
  /** Expected service duration, used before observed data exists. */
  readonly serviceEstimateMillis: number;
  readonly sla: StationSla;
  readonly queueNumber: QueueNumberConfig;
  /**
   * Whether this station may appear on a public display board. Reception and
   * clinical back-offices generally should not.
   */
  readonly isPublic: boolean;
  readonly enabled: boolean;
}

export interface DisplayBoardConfig {
  readonly id: string;
  readonly name: string;
  readonly stationIds: readonly StationId[];
  readonly waitingToShow: number;
  readonly namePolicy: PatientNamePolicy;
  readonly showEstimatedWait: boolean;
  readonly showRoom: boolean;
}

export interface HospitalProfile {
  readonly id: HospitalId;
  readonly name: string;
  readonly code: string;
  readonly timezone: string;
  readonly supportPhone: string | null;
  /** Brand colour, applied to the patient-facing surfaces. */
  readonly brandColor: string;
}

export interface BranchConfig {
  readonly id: BranchId;
  readonly name: string;
  readonly code: string;
  readonly isDefault: boolean;
}

export interface HospitalConfiguration {
  readonly profile: HospitalProfile;
  readonly branches: readonly BranchConfig[];
  readonly stations: readonly StationConfig[];
  readonly workflows: readonly Workflow[];
  readonly displayBoards: readonly DisplayBoardConfig[];
  readonly ticketTemplates: readonly TicketTemplate[];
  readonly defaults: {
    /** Applied to any surface that does not override it. */
    readonly namePolicy: PatientNamePolicy;
    /** Ticket template used when a station does not specify one. */
    readonly ticketTemplateId: string;
  };
}

/**
 * A problem with a configuration, addressed to the administrator who caused it.
 *
 * `path` locates it in the UI so the portal can jump to the offending field.
 * Errors block saving; warnings do not — a station with no room set is worth
 * mentioning but is not wrong, and refusing to save it would just teach
 * administrators to enter junk.
 */
export interface ConfigProblem {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function validateHospitalConfiguration(
  config: HospitalConfiguration,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  const error = (path: string, message: string) =>
    problems.push({ path, message, severity: "error" });
  const warn = (path: string, message: string) =>
    problems.push({ path, message, severity: "warning" });

  // ------------------------------------------------------------------ profile
  if (config.profile.name.trim().length === 0) {
    error("profile.name", "The hospital needs a name.");
  }
  if (!HEX_COLOR.test(config.profile.brandColor)) {
    error("profile.brandColor", "Brand colour must be a hex value like #003ec7.");
  }
  if (config.branches.length === 0) {
    error("branches", "At least one branch is required.");
  }
  if (config.branches.length > 0 && !config.branches.some((b) => b.isDefault)) {
    warn("branches", "No branch is marked as the default.");
  }

  // ----------------------------------------------------------------- stations
  const stationIds = new Set<string>();
  const stationCodes = new Map<string, string>();

  for (const station of config.stations) {
    const path = `stations.${station.id}`;

    if (station.name.trim().length === 0) {
      error(`${path}.name`, "Every station needs a name.");
    }
    if (stationIds.has(station.id)) {
      error(path, `Two stations share the id "${station.id}".`);
    }
    stationIds.add(station.id);

    const code = station.code.trim().toUpperCase();
    if (code.length === 0) {
      error(`${path}.code`, "Every station needs a short code.");
    } else if (stationCodes.has(code)) {
      // Not fatal, but a duplicate code makes {station} templates ambiguous on
      // a printed ticket.
      warn(
        `${path}.code`,
        `Station code "${code}" is also used by ${stationCodes.get(code)}.`,
      );
    } else {
      stationCodes.set(code, station.name);
    }

    if (station.staffing < 1) {
      error(`${path}.staffing`, "A station needs at least one member of staff.");
    }
    if (station.serviceEstimateMillis <= 0) {
      error(
        `${path}.serviceEstimateMillis`,
        "Expected service time must be greater than zero.",
      );
    }
    if (station.sla.targetWaitMillis <= 0) {
      error(`${path}.sla`, "A wait target must be greater than zero.");
    }
    if (station.sla.saturationPoint < 1) {
      error(`${path}.sla`, "Saturation point must be at least one patient.");
    }
    if (station.room === null || station.room.trim().length === 0) {
      warn(
        `${path}.room`,
        "No room set — patients will not be told where to go.",
      );
    }

    for (const message of validateQueueNumberConfig(station.queueNumber)) {
      error(`${path}.queueNumber`, message);
    }
  }

  // ---------------------------------------------------------------- workflows
  if (config.workflows.length === 0) {
    error("workflows", "At least one workflow is required to admit a patient.");
  }
  if (config.workflows.length > 0 && !config.workflows.some((w) => w.isDefault)) {
    warn("workflows", "No workflow is marked as the default.");
  }

  for (const workflow of config.workflows) {
    const path = `workflows.${workflow.id}`;
    for (const message of validateWorkflow(workflow)) {
      error(path, message);
    }
    for (const stage of workflow.stages) {
      if (!stationIds.has(stage.stationId)) {
        error(
          path,
          `"${workflow.name}" includes a station that no longer exists.`,
        );
      } else if (
        !config.stations.find((s) => s.id === stage.stationId)?.enabled
      ) {
        warn(
          path,
          `"${workflow.name}" routes through a disabled station.`,
        );
      }
    }
  }

  // ----------------------------------------------------------- display boards
  const boardIds = new Set<string>();
  for (const board of config.displayBoards) {
    const path = `displayBoards.${board.id}`;

    if (boardIds.has(board.id)) {
      error(path, `Two display boards share the id "${board.id}".`);
    }
    boardIds.add(board.id);

    if (board.name.trim().length === 0) {
      error(`${path}.name`, "Every display board needs a name.");
    }
    if (board.stationIds.length === 0) {
      error(`${path}.stationIds`, "A display board must show at least one station.");
    }
    if (board.waitingToShow < 1) {
      error(
        `${path}.waitingToShow`,
        "A board must list at least one waiting ticket.",
      );
    }

    for (const stationId of board.stationIds) {
      const station = config.stations.find((s) => s.id === stationId);
      if (!station) {
        error(path, "This board shows a station that no longer exists.");
        continue;
      }
      if (!station.isPublic) {
        // The privacy check that matters most: a non-public station on a
        // waiting-room screen exposes a queue that was never meant to be seen.
        error(
          path,
          `"${station.name}" is not a public station and must not appear on a display board.`,
        );
      }
      if (!station.enabled) {
        warn(path, `"${station.name}" is disabled and will show as empty.`);
      }
    }
  }

  // ---------------------------------------------------------- ticket templates
  if (config.ticketTemplates.length === 0) {
    error("ticketTemplates", "At least one ticket template is required.");
  }

  const templateIds = new Set<string>();
  for (const template of config.ticketTemplates) {
    const path = `ticketTemplates.${template.id}`;
    if (templateIds.has(template.id)) {
      error(path, `Two ticket templates share the id "${template.id}".`);
    }
    templateIds.add(template.id);

    for (const message of validateTicketTemplate(template)) {
      error(path, message);
    }
  }

  if (
    config.ticketTemplates.length > 0 &&
    !templateIds.has(config.defaults.ticketTemplateId)
  ) {
    error(
      "defaults.ticketTemplateId",
      "The default ticket template no longer exists.",
    );
  }

  return problems;
}

export function hasBlockingProblems(problems: readonly ConfigProblem[]): boolean {
  return problems.some((problem) => problem.severity === "error");
}

export function problemsFor(
  problems: readonly ConfigProblem[],
  pathPrefix: string,
): ConfigProblem[] {
  return problems.filter((problem) => problem.path.startsWith(pathPrefix));
}
