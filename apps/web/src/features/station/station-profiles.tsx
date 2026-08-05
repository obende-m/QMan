import { Activity, FlaskConical, Pill, Stethoscope, Scan } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A Station Profile is the only thing that differs between the Consultation,
 * Vitals, Laboratory, Radiology and Pharmacy workspaces.
 *
 * The SAD's guiding principle is that adding a station requires no code change.
 * `StationWorkspace` honours that literally: it reads the station's queue from
 * the domain and its onward destinations from the workflow, so a station with no
 * profile at all still works. A profile only supplies vocabulary — what this
 * station calls the work it does — because "Time in consult" is wrong at a
 * pharmacy and "Now dispensing" is wrong at a doctor's desk.
 *
 * Nothing here is required. Falling back to generic wording is correct
 * behaviour for a station an administrator created five minutes ago.
 */
export interface StationProfile {
  /** Heading over the active patient card, e.g. "Now serving". */
  activeLabel: string;
  /** Label above the running timer, e.g. "Time in consult". */
  timerLabel: string;
  /** Verb on the button that begins service, e.g. "Start consult". */
  startLabel: string;
  icon: ReactNode;
}

const GENERIC: StationProfile = {
  activeLabel: "Now serving",
  timerLabel: "Time at station",
  startLabel: "Start service",
  icon: <Activity className="size-4" />,
};

const PROFILES: Record<string, StationProfile> = {
    OPD: {
    activeLabel: "Now serving",
    timerLabel: "Time in consult",
    startLabel: "Start consult",
    icon: <Stethoscope className="size-4" />,
  },
    VIT: {
    activeLabel: "Now assessing",
    timerLabel: "Time in triage",
    startLabel: "Start assessment",
    icon: <Activity className="size-4" />,
  },
    LAB: {
    activeLabel: "Now collecting",
    timerLabel: "Time at collection",
    startLabel: "Start collection",
    icon: <FlaskConical className="size-4" />,
  },
    PHR: {
    activeLabel: "Now dispensing",
    timerLabel: "Time at counter",
    startLabel: "Start dispensing",
    icon: <Pill className="size-4" />,
  },
  // Radiology has no station seeded in the demo clinic yet; the profile is here
  // to show that vocabulary is pure configuration.
  "st-radiology": {
    activeLabel: "Now imaging",
    timerLabel: "Time in imaging",
    startLabel: "Start imaging",
    icon: <Scan className="size-4" />,
  },
};

/**
 * Keyed on the station's code rather than its identifier.
 *
 * Identifiers are the server's and differ per hospital; the code is what an
 * administrator types and what the queue-number template already uses. A
 * hospital with a code this does not recognise gets the generic profile, which
 * is the correct outcome rather than a missing screen.
 */
export function profileFor(code: string): StationProfile {
  return PROFILES[code.toUpperCase()] ?? GENERIC;
}
