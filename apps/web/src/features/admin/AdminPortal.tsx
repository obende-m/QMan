import { useMemo, useState } from "react";
import {
  Building2,
  LayoutGrid,
  MonitorPlay,
  ShieldCheck,
  TriangleAlert,
  MonitorSmartphone,
  Printer,
  Users,
  Volume2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  hasBlockingProblems,
  problemsFor,
  type ConfigProblem,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { cn } from "../../components/ui/cn.js";
import type { ConfigStore } from "../../data/config-store.js";
import { stores } from "../../data/runtime-stores.js";
import { useConfig } from "../../data/useConfig.js";
import { useOperations } from "../../data/useOperations.js";
import type { OperationsStore } from "../../data/operations-store.js";
import { StationsSection } from "./StationsSection.js";
import { AnnouncementsSection } from "./AnnouncementsSection.js";
import { TicketsSection } from "./TicketsSection.js";
import { DisplayBoardsSection } from "./DisplayBoardsSection.js";
import { WorkflowsSection } from "./WorkflowsSection.js";
import { RolesSection } from "./RolesSection.js";
import { SessionsSection } from "./SessionsSection.js";
import { useAuth } from "../../data/useAuth.js";
import { HospitalSection } from "./HospitalSection.js";

/**
 * The Administration Portal.
 *
 * This is the module that decides whether QMan is software or a platform.
 * Everything it edits — stations, queue-number templates, reset strategies,
 * SLAs, workflows, display boards, privacy policy, roles — was previously a
 * constant compiled into the bundle. A hospital that wanted a Dialysis station
 * needed a developer; now it needs an administrator and two minutes.
 *
 * Two principles run through it:
 *
 *  - **Validate on write, in the domain.** Every save goes through
 *    `validateHospitalConfiguration`, the same function the API will run when
 *    the portal posts to it. Errors block the save; warnings do not, because a
 *    guard that blocks on "no room set" only teaches administrators to type
 *    junk into the field.
 *  - **Show the consequence, not the field.** A queue-number template is
 *    meaningless as a string; it is obvious as a live preview reading `A-007`.
 */
export type AdminSection =
  | "hospital"
  | "stations"
  | "workflows"
  | "boards"
  | "announcements"
  | "tickets"
  | "roles"
  | "sessions";

const SECTIONS: ReadonlyArray<{
  key: AdminSection;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    key: "hospital",
    label: "Hospital",
    description: "Profile, branches, branding and privacy defaults",
    icon: <Building2 className="size-4" />,
  },
  {
    key: "stations",
    label: "Stations",
    description: "Queue numbering, reset policy, SLAs and rooms",
    icon: <LayoutGrid className="size-4" />,
  },
  {
    key: "workflows",
    label: "Workflows",
    description: "How patients move between stations",
    icon: <WorkflowIcon className="size-4" />,
  },
  {
    key: "boards",
    label: "Display Boards",
    description: "Which stations appear on which screen",
    icon: <MonitorPlay className="size-4" />,
  },
  {
    key: "announcements",
    label: "Announcements",
    description: "What patients hear and read when they are called",
    icon: <Volume2 className="size-4" />,
  },
  {
    key: "tickets",
    label: "Printed Tickets",
    description: "Layouts for each printer the hospital uses",
    icon: <Printer className="size-4" />,
  },
  {
    key: "roles",
    label: "Roles & Permissions",
    description: "What each kind of staff member may do",
    icon: <Users className="size-4" />,
  },
  {
    key: "sessions",
    label: "Sessions",
    description: "Who is signed in, and on which machine",
    icon: <MonitorSmartphone className="size-4" />,
  },
];

export interface AdminPortalProps {
  store?: ConfigStore;
  operations?: OperationsStore;
}

export function AdminPortal({
  store: injected = stores.config,
  operations: injectedOps,
}: AdminPortalProps) {
  const config = useConfig(injected);
  const ops = useOperations(injectedOps);
  const auth = useAuth();
  const [section, setSection] = useState<AdminSection>("stations");
  const version = config.getVersion();

  const problems = useMemo(() => config.problems, [config, version]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-headline-lg-mobile font-semibold tracking-tight text-on-surface md:text-headline-lg">
          Administration
        </h1>
        <p className="mt-1 text-body-md text-on-surface-variant">
          Configure {config.config.profile.name}. Changes apply immediately
          across every screen.
        </p>
      </div>

      <ConfigHealth problems={problems} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <nav aria-label="Administration sections" className="lg:sticky lg:top-4 lg:self-start">
          <ul className="flex flex-wrap gap-1 lg:flex-col">
            {SECTIONS.map((item) => {
              const selected = item.key === section;
              const sectionProblems = problemsFor(problems, pathFor(item.key));
              const hasErrors = hasBlockingProblems(sectionProblems);
              return (
                <li key={item.key} className="flex-1 lg:flex-none">
                  <button
                    type="button"
                    onClick={() => setSection(item.key)}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-body-sm font-semibold transition-colors",
                      selected
                        ? "bg-surface-container-low text-primary"
                        : "text-on-surface-variant hover:bg-surface-container-high",
                    )}
                  >
                    <span aria-hidden="true">{item.icon}</span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {hasErrors && (
                      <span
                        aria-label="Has errors"
                        className="size-2 shrink-0 rounded-full bg-error"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div>
          {section === "hospital" && <HospitalSection store={config} problems={problems} />}
          {section === "stations" && <StationsSection store={config} problems={problems} />}
          {section === "workflows" && <WorkflowsSection store={config} problems={problems} />}
          {section === "boards" && <DisplayBoardsSection store={config} problems={problems} />}
          {section === "announcements" && (
            <AnnouncementsSection store={config} operations={ops} />
          )}
          {section === "tickets" && (
            <TicketsSection store={config} problems={problems} />
          )}
          {section === "roles" && <RolesSection store={config} />}
          {section === "sessions" && <SessionsSection />}
        </div>
      </div>
    </div>
  );
}

function pathFor(section: AdminSection): string {
  switch (section) {
    case "hospital":
      return "profile";
    case "stations":
      return "stations";
    case "workflows":
      return "workflows";
    case "boards":
      return "displayBoards";
    case "announcements":
      return "announcements";
    case "tickets":
      return "ticketTemplates";
    case "roles":
      return "roles";
    case "sessions":
      return "sessions";
  }
}

/**
 * A standing summary of configuration health.
 *
 * An administrator should never have to hunt for what they broke — and warnings
 * are surfaced too, because "no room set" is exactly the sort of omission that
 * is invisible until a patient asks where to go.
 */
function ConfigHealth({ problems }: { problems: readonly ConfigProblem[] }) {
  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warning");

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <Card className="border-tertiary/30 bg-tertiary/5">
        <div className="flex items-center gap-3 px-gutter py-4">
          <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
          <p className="text-body-md text-on-surface">
            Configuration is valid. No problems found.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card className={errors.length > 0 ? "border-error/30" : "border-warning/40"}>
      <CardHeader
        title={
          errors.length > 0
            ? `${errors.length} ${errors.length === 1 ? "problem" : "problems"} to fix`
            : `${warnings.length} ${warnings.length === 1 ? "suggestion" : "suggestions"}`
        }
        subtitle={
          errors.length > 0
            ? "Changes that would leave the hospital in this state are refused."
            : "Not blocking, but worth reviewing."
        }
      />
      <ul className="divide-y divide-outline-variant border-t border-outline-variant">
        {[...errors, ...warnings].map((problem, index) => (
          <li
            key={`${problem.path}-${index}`}
            className="flex items-start gap-3 px-gutter py-3"
          >
            <TriangleAlert
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-4 shrink-0",
                problem.severity === "error" ? "text-error" : "text-warning",
              )}
            />
            <div className="min-w-0">
              <p className="text-body-sm text-on-surface">{problem.message}</p>
              <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                {problem.path}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
