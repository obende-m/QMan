# Architectural Decisions

A running record of decisions that depart from, or materially sharpen, the PRD,
SAD and ERD. Each entry states the decision, the reasoning, and what it costs.

---

## ADR-001 — The domain package has zero dependencies

**Decision.** `@qman/domain` imports nothing. No HTTP, no ORM, no framework, no
`Date.now()`, no `crypto`. Everything from outside arrives through a port:
`Clock`, `IdGenerator`, `RandomSource`, `EventPublisher`.

**Why.** The SAD asks for a Domain layer that holds the business logic, and the
PRD's commercial ambition depends on that logic being trustworthy. A dependency-
free domain means the entire patient-flow rulebook runs in ~100ms with no
database, so the rules can be exercised exhaustively rather than sampled. It is
also what makes the "three products, one engine" split real: analytics can
consume the domain without inheriting a web server.

**Cost.** Slightly more ceremony — infrastructure must wire the ports in. This is
paid once, in `apps/api`.

---

## ADR-002 — Time is injected, never ambient

**Decision.** Domain code never calls `new Date()`. It takes a `Clock`.

**Why.** Every metric QMan sells — average waiting time, average service time,
bottleneck detection — is a subtraction of two timestamps. If the domain reads
the system clock directly, none of those calculations can be tested
deterministically, and the analytics module becomes the least verifiable part of
the product despite being the one sold on precision. `FixedClock` lets a test
advance 110 minutes across a nine-step journey and assert the total exactly.

---

## ADR-003 — "Transferred" and "Completed Stage" are events, not states

**Decision.** The SAD's lifecycle lists `Completed Stage → Transferred → Queued`.
Implemented, a visit is only ever `Queued` or `InProgress` between stations;
routing is one atomic operation that closes the outgoing queue entry and opens
the incoming one. The distinction survives as two events on the audit trail:
`visit.stage_completed` and `visit.routed`.

**Why.** `Completed Stage` and `Transferred` describe the same instant — a
station finishing with a patient and handing them on. Modelling them as distinct
resting states creates a window in which the visit belongs to no queue and
appears on no worklist. In a busy hospital that window is a lost patient, and it
is exactly the failure QMan exists to eliminate. Making the handover atomic makes
the loss unrepresentable rather than merely unlikely.

**What is preserved.** Everything the original states were for. The audit trail
still shows the stage completing and the transfer happening as separate,
timestamped facts, with the service duration attached.

---

## ADR-004 — `Completed` and `Closed` remain separate

**Decision.** Kept as two states, as the SAD specifies.

**Why.** `Completed` means clinical work finished; `Closed` means the record is
sealed. The gap between them is the correction window — the period in which a
receptionist can fix a mis-keyed hospital number before the audit trail locks.
Collapsing them would force a choice between an immutable trail and a correctable
one. `completed` also permits `route`, which is what implements the SAD's
lab-results review leg: a finished visit can be pulled back for a doctor to
review, without reopening a sealed record.

---

## ADR-005 — The transition table is the sole authority, and is consulted first

**Decision.** One frozen table in `visit-status.ts` defines every legal
`(state, action) → state`. Nothing else may assign `Visit.status`. Every aggregate
method resolves the next status **before** inspecting queue entries, and assigns
it **last**, after all other validation has passed.

**Why.** Two properties fall out of this. First, the audit trail is complete by
construction: an event exists for every transition because a transition cannot
occur anywhere else. Second, error messages are correct — acting on a closed
visit reports "this visit is closed", not "this visit is not in any queue", which
is what happens when entry state is checked first. Assigning status last also
makes the actions exception-safe: a validation failure part-way through cannot
leave the aggregate in a state that never legally existed.

This ordering was not the first implementation; four tests caught the inverted
version, which is precisely the argument for having them.

**Bonus.** The table is small enough to test exhaustively. One test walks every
`(state, action)` pair; another proves by graph search that no state can become a
dead end from which a visit can never be closed.

---

## ADR-006 — Priority is weights, and VIP never outranks clinical urgency

**Decision.** Priorities are `emergency (300) > high (200) > vip (100) >
normal (0)`, expressed as tunable weights rather than enum ordering.

**Why.** The PRD lists the four priorities without an ordering, which leaves the
most consequential question in the queue unanswered. Placing VIP below both
clinical tiers is a clinical-safety position: a commercial courtesy tier must
never delay a patient who is medically urgent. Weights rather than positions mean
a hospital can retune the gaps through configuration without a schema migration —
and makes the ranking auditable, which matters if it is ever questioned.

---

## ADR-007 — A skipped patient keeps their queue entry and their arrival time

**Decision.** Skipping does not delete the ticket or issue a new one. The queue
entry stays open, flagged `skipped`, and the visit returns to `queued`. In the
ordering, a skipped patient yields to peers of equal priority but keeps their
original arrival timestamp.

**Why.** "Called and did not answer" is the single most common real-world queue
event, and naive systems handle it by discarding the ticket — which means the
patient who stepped out to use the bathroom loses their whole morning. Keeping
the entry preserves their place and their waiting-time record. Yielding to peers
stops a repeatedly-absent patient from blocking the front of the queue
indefinitely. Keeping the arrival time stops them being punished by being sent to
the back. The two rules together produce the behaviour a receptionist would
apply by hand.

---

## ADR-008 — Workflows are a sequence plus branches, not a general graph

**Decision.** A workflow is an ordered list of stages. Each stage may declare
`branchesTo` (extra permitted destinations) and `allowRepeat` (may be returned
to). Routing offers the next stage in sequence as the primary action and branches
as secondary.

**Why.** The PRD requires administrators to build workflows with no programming.
A general graph editor is the obvious implementation and the wrong one — it asks
a hospital administrator to think about nodes and edges. A sequence is how they
already describe the journey ("reception, then vitals, then the doctor"), while
branches cover the clinical detours that actually occur. The overwhelmingly
common route — the next step — needs one click; the exceptions need two.

`validateWorkflow` runs at configuration time, so a mistake surfaces when an
administrator saves, not when a patient is standing at the desk.

**Cost.** A genuinely graph-shaped workflow must be expressed through branches.
Acceptable: no journey in the PRD needs more.

---

## ADR-009 — Journey codes are designed for a noisy room and a phone keypad

**Decision.** A 30-symbol alphabet excluding `I L O U 0 1`, formatted `QM-8F4K`.
Input is normalised aggressively before lookup, including repairing the excluded
characters.

**Why.** The code is read aloud across a waiting room, printed on a thermal
ticket, and typed by a patient on a phone. Excluding look-alikes removes the
common failure at the source. The repair step then exploits the exclusion: since
`I`, `L`, `1`, `O` and `0` can never appear in a generated code, encountering one
is *proof* of a mis-read, and the intended character is unambiguous — so
`QM-I7ON` resolves to `QM-J7QN` rather than failing. `U` is dropped so short
codes cannot spell profanity.

30⁴ = 810,000 codes at the default length. Uniqueness is scoped to *active*
visits, not all visits ever, so codes recycle daily and stay four characters.
Collisions retry; saturation lengthens the code rather than turning a patient
away.

---

## ADR-010 — One queue-entry table, one worklist model

**Decision.** As the ERD urges, a single `QueueEntry` shape for every station,
distinguished by `stationId`. Extended to the read side: one `StationWorklist`
model serves Doctor, Lab, Vitals, Radiology and Pharmacy.

**Why.** This is what makes the SAD's guiding principle true — adding Dialysis or
MRI creates rows, never tables and never code. Carrying it through to the read
model means the five station workspaces the PRD lists are one component with
different data, not five screens to keep in sync. A test adds a Dialysis station
to a workflow and routes a patient through it with no code change, which is the
principle stated as an executable assertion.

---

## ADR-011 — Wait estimates use observed service time and are deliberately padded

**Decision.** `estimateWaitMillis` prefers the station's *observed* mean service
time today over the configured estimate, divides by staff actually on the
station, and pads the result by 15%.

**Why.** A configured duration describes how long a consultation is supposed to
take; the observed mean describes how long it is taking this morning, with this
doctor, at this clinic. The second is what the patient is actually waiting for.
The padding is asymmetric on purpose: being seen earlier than told is a pleasant
surprise, being seen later is the complaint the product exists to prevent. The
UI should present the result as a range.

---

---

## ADR-012 — One token file drives Tailwind, and themes run on CSS variables

**Decision.** `apps/web/src/design/tokens.ts` transcribes `DESIGN.md` and is the
only place a colour, type step or spacing value is written. The Tailwind config
derives everything from it, and colours resolve through CSS custom properties
emitted as `r g b` channels — `rgb(var(--color-primary) / <alpha-value>)`.

**Why.** The alternative, hardcoding hex in the Tailwind config, means every
component needs a `dark:` variant and dark mode decays the moment someone
forgets one. With variables, a single `.dark` class on `<html>` re-themes the
whole application and no component mentions a theme at all. Emitting channels
rather than hex keeps Tailwind's alpha modifiers working, which the "In
Progress" chip needs — `DESIGN.md` specifies it as primary blue at low opacity.

`DESIGN.md` calls for a dark theme for night shifts but supplies no dark palette,
so one was derived. Night shifts are when a patient-flow system is most
safety-critical, so it is a designed theme rather than an inverted one.

---

## ADR-013 — Icons and fonts are local, not CDN

**Decision.** Material Symbols (loaded from Google Fonts in the Stitch export) is
replaced with `lucide-react`. Inter and JetBrains Mono are self-hosted via
`@fontsource`.

**Why.** QMan targets hospitals with unreliable connectivity, and a waiting-room
display board that falls back to Times New Roman — or loses its icons entirely —
because a font request timed out is a visible, public failure. Self-hosting also
removes a third-party request from every page load in an environment with
patient data on screen.

`lucide-react` additionally tree-shakes to the ~20 glyphs actually used, where
the Material Symbols font ships the whole set. The icons were matched
one-for-one, so the visual language is unchanged.

**Cost.** One dependency, and icon shapes differ slightly from the mockups.

---

## ADR-014 — Chips and load levels are derived from domain types

**Decision.** `StatusChip` does not accept a free-form variant string. Its
mappings are exhaustive `switch` statements over the domain's own `VisitStatus`,
`QueueEntryStatus` and `Priority` unions.

**Why.** Adding a status to the engine now becomes a compile error in the UI
until that status is given an appearance. The UI cannot silently fail to render
a state the engine is capable of producing — which, for a screen a nurse uses to
decide who to see next, is the difference between a build failure and a patient
who is invisible.

Station load is classified by a ratio against a per-station saturation point
rather than absolute counts, because a five-person queue means something very
different at Radiology than at Reception.

---

## ADR-015 — Priority Patients is a section, not a re-sort

**Decision.** Emergency and High visits get a dedicated section above Recent
Visits. Recent Visits stays strictly chronological.

**Why.** The finding recorded earlier was that arrival-ordering can push an
urgent patient off the list entirely. Re-sorting the table would fix visibility
by making "Recent Visits" mean something other than recent, and a receptionist
scanning for the walk-in who just arrived would find the list lying to them.
Two lists, each honest about what it contains, beats one list trying to be both.

**VIP is excluded deliberately.** It appears in neither the section nor its
counts. Putting a commercial courtesy tier in a band staff read as "clinically
urgent" is precisely the confusion ADR-006 exists to prevent.

The section also carries a wait-target per tier (10 minutes for Emergency, 30
for High) and marks breaches, so it reports whether the hospital is meeting its
own standard rather than only who is waiting.

---

## ADR-016 — Journey Code is identity; queue numbers are station tickets

**Decision.** Two distinct identifiers, and the model keeps them apart:

| | Journey Code | Queue number |
| --- | --- | --- |
| Example | `QM-8F4K` | `A-001`, `L-014`, `P-007` |
| Scope | the whole visit | one station |
| Lifetime | permanent | reissued at each station |
| Used for | tracking portal, QR, search, audit | calling the patient forward |

Routing to a station issues a fresh ticket from *that* station's own series and
format. The Journey Code is untouched.

**Why.** These were conflated in the source designs — the Clinical Workspace
labelled `A-402` as "Code" while Reception showed `QM-8F4K`. Conflating them
breaks in both directions: a patient tracking `A-402` loses their identity the
moment they are routed, and a station calling `QM-8F4K` across a waiting room
is announcing a code that means nothing about position in *this* queue.

---

## ADR-017 — Queue numbering is one template engine, not four formats

**Decision.** A station's numbering config is a single template string —
`A-{n:3}`, `LAB-{n:3}`, `{n:3}`, `{journey}` — with tokens for the ordinal,
station code, journey code and date parts. The four named formats are presets
that compile to templates.

**Why.** The requirement listed sequential, journey-code, department-prefix,
numeric-only *and* "custom formats". Implementing the first four as separate
cases means the fifth needs a release; implementing the general case means all
five are configuration and the named formats are a convenience. `{station}`
matters especially: one configuration then serves every station, because the
prefix comes from the station rather than from the config.

`validateQueueNumberConfig` runs at configuration time and rejects the two
mistakes that matter — an unknown token, and a template with no varying part
(which would issue every patient the same ticket). An unknown token renders
verbatim rather than being silently dropped, so a misconfiguration is visible on
the board instead of producing a plausible but wrong ticket.

---

## ADR-018 — The issued ticket label is stored, not recomputed

**Decision.** `QueueEntry` carries both `queueNumber` (the ordinal the system
allocates and sorts by) and `queueLabel` (the ticket as issued). The label is
rendered once, at allocation, and persisted.

**Why.** Configuration changes, and history must not change with it. A patient
holding a printed slip reading `A-001` must still match the display board after
an administrator switches the station to department prefixes at lunchtime, and
last week's audit trail must not silently re-render under this week's format.
This is the same reasoning as recording price-at-time-of-sale rather than
joining to a current price list.

Keeping the ordinal separate preserves what the label cannot do: allocate the
next number, and sort. A `{journey}` template produces labels with no ordering
information at all, so the two fields are not redundant.

---

## ADR-019 — The display board is furniture, not a screen

**Decision.** The board renders outside the staff shell — no sidebar, no search,
no navigation — commits to a fixed dark palette regardless of the viewer's
theme, and shows every configured station at once rather than cycling.

**Why.** Each follows from where it lives. It runs unattended on a wall-mounted
TV, so navigation is only something to mis-click. It is read from across a room
and hangs in a space people sit in for an hour, so a bright screen is a physical
imposition and the type is far larger than any staff screen would justify. And a
carousel forces a patient to wait for their station to come back round, which is
the anxiety the product exists to remove.

**Names are off by default.** The board shows tickets. A queue number is
sufficient to call someone forward, and a patient's name on a public screen in a
waiting room is an avoidable privacy exposure — the kind that is trivial to
prevent at design time and awkward to walk back after deployment. Hospitals that
want names opt in per board.

**Which stations appear is per-board configuration**, so the main atrium, the
lab anteroom and an emergency area are three rows, not three components.

---

## ADR-020 — Position is derived; the ticket is stored

**Decision.** A queue entry stores its ticket (`A-064`) permanently. Queue
*position* is computed on every read from the station's live ordered worklist
and is never persisted.

**Why.** They answer different questions and change on different clocks. The
ticket answers "which patient are you at this station" and must not move — it is
printed on a slip and read aloud. The position answers "how many people are in
front of you", and is wrong the instant anyone else is called, skipped or
escalated. Storing it would mean every call at a station triggers a write to
every other waiting visit, and any missed write leaves a patient looking at a
stale number on their phone.

Deriving it costs an array scan over one station's queue and makes staleness
structurally impossible.

---

## ADR-021 — Resets are a period key, not a scheduled job

**Decision.** `QueueNumberConfig.reset` supports `daily`, `weekly`, `monthly`,
`never` and `manual`, per station. Allocation is keyed by
`(station, periodKey)`, where the period key is computed from the current time —
`2026-03-09`, `2026-W11`, `2026-03`, `all`, or `manual:<epoch>`.

**Why.** The obvious implementation is a midnight job that zeroes counters. That
job can fail, run twice, run in the wrong timezone, or run while a patient is
mid-admission — and when it does, it destroys the day's numbering with no record
of what it overwrote. Keying by period means nothing has to run at all: the
series restarts because the key changed. Yesterday's ordinals remain queryable
rather than being overwritten, which also makes historical reporting possible.

`manual` exists because some units reset per session or per ward round, on a
cadence no calendar rule captures. Those hospitals need a button, and bumping
`manualEpoch` is that button.

Weekly uses true ISO-8601 week numbering, so the week does not change meaning
across a year boundary — 31 December 2025 correctly belongs to `2026-W01`.

---

## ADR-022 — Name visibility is a domain policy, not a display prop

**Decision.** `PatientNamePolicy` (`ticket_only` | `first_name` | `full_name`)
lives in the domain with a `displayPatientName` function, and is configured per
display board. Default is `ticket_only`.

**Why.** It began as a boolean on a display component, which was wrong in a way
worth naming: this is a hospital's privacy policy, and the same rule will have to
govern SMS bodies, push notification previews and printed tickets the moment
those exist. A policy enforced inside one component is a policy that leaks the
first time a second component renders a name. Putting it in the domain means
every future surface has to go through the same function.

`displayPatientName` returns `null` rather than an empty string when no name may
be shown, so callers must handle absence explicitly instead of rendering blank
space. Mononyms — common across QMan's markets — return the whole name under a
first-name policy rather than nothing.

---

## ADR-023 — Three applications, one engine

**Decision.** The staff app, the display board and the patient tracker are three
Vite entry points producing three bundles, not three routes in one.

**Why.** Two of the three are loaded by people who are not staff, on devices the
hospital does not control. Keeping them separate builds means the public bundles
contain no code that can call, skip, route, escalate or complete a patient —
that becomes a property of the artefact rather than a promise about routing and
permission checks. It is the difference between "the UI does not show those
buttons" and "those functions are not in the file".

It also matches how they run. The board is unattended signage with a lifetime of
weeks and no authentication; a receptionist's worklist should not be one
mis-click away from it, and it must restart into the board rather than a login.
The tracker is opened on hospital wi-fi or mobile data, often on an old phone,
so its bundle size matters in a way the staff app's does not.

Measured result: staff 51 kB, tracker 6.6 kB, board 4.9 kB, all sharing the same
domain engine, design tokens and component library.

Which board or which journey is selected comes from the URL
(`/display.html?board=board-lab`, `/track.html?code=QM-8F4K`), so one build
serves every screen in the hospital and a QR code lands a patient directly on
their own journey.

---

## ADR-024 — Operations Intelligence is pure functions over the same projections

**Decision.** Station health, bottleneck ranking, longest-waiting patient, staff
workload and the clinic pulse are pure functions in
`@qman/domain/analytics`, operating on the same `StationWorklist` projections
the station screens render.

**Why.** This is the third of the PRD's three products, and the failure mode for
an analytics module is that it grows its own copy of the data and slowly starts
disagreeing with the floor. A manager whose dashboard says twelve waiting while
the station screen says nine stops trusting both. Sharing the projection makes
disagreement impossible, and keeping the functions pure means the whole of
Operations Intelligence is testable without a database, a chart library or
React.

**Station status keys off the longest current wait, not the average.** An
average hides the one patient who has been sitting for 50 minutes behind nine
who were seen in five — and that patient is the one who complains, and the one a
manager needs to hear about first. "At risk" fires at 75% of target, which is
the point where intervention can still prevent the breach rather than merely
record it.

**Staff workload reports throughput without ranking.** A leaderboard in a
clinical setting rewards rushing patients, and the fastest consultation is
rarely the best one. Managers get the distribution and the context; what to do
about it is a human judgement.

---

## ADR-025 — The manager dashboard identifies cases, not patients

**Decision.** The Manager Dashboard shows station and ticket — "Laboratory,
L-023, waiting 51 minutes" — and never a patient name or Journey Code. Identity
lives one click away in the station workspace, behind that station's permissions.
The `Manager` role does not carry `visit.view_identity` by default.

**Why.** It was originally built to name the individual, on the argument that
"Grace Mensah, 51 minutes" is what makes a manager act. That was the wrong
trade. An operational dashboard is read on a large screen in an open office, is
often left up all day, and answers a question that does not require identity:
which queue is failing and by how much. Station plus ticket is enough to act on
and enough to drill into.

This also makes the privacy posture consistent. Having argued for ticket-only
display boards, defaulting a dashboard to full names was an inconsistency that
would have been noticed first by whoever audits the deployment.

---

## ADR-026 — Configuration is data, validated in the domain

**Decision.** `HospitalConfiguration` — profile, branches, stations, workflows,
display boards, privacy defaults — is a domain type with a
`validateHospitalConfiguration` function, held in a live store the whole
application reads from. Everything the Administration Portal edits was
previously a frozen constant compiled into the bundle.

**Why.** This is what the word "platform" was standing in for. Before it, a
hospital wanting a Dialysis station, a different ticket format or a second
display board needed a developer, a build and a deploy. After it, those are
three fields and a save.

Validation lives in the domain, not the portal, because the API will have to run
exactly the same checks when the portal posts to it — and two validators that
must agree are one validator too many.

**Errors block; warnings do not.** A station with no room set is worth flagging
and is not wrong. Blocking it would teach administrators to type junk into the
field to get past the guard, which is worse than the omission.

**Consequences are shown, not fields.** A queue-number template is meaningless
as a string and obvious as a live preview reading `A-007`. The station editor
renders a real ticket, and the workflow editor renders the destinations the
routing engine will actually offer, rather than the rule that produces them.

---

## ADR-027 — Permissions are a closed catalogue; roles are data

**Decision.** `Permission` is a union of ~18 named permissions defined in the
domain. Roles are editable records mapping to them.

**Why.** A mistyped permission string is a check that silently never passes — or
a guard that is never applied at all. Making the catalogue closed turns that
class of mistake into a compile error. Roles stay data because a hospital
inventing "Senior Triage Nurse" should not need a release.

`validateRoles` refuses any edit that would leave no role holding
`admin.users`. It is the single mistake in this module that cannot be undone
from inside the product: a hospital that removes it locks itself out of its own
administration and needs a support engineer with database access.

---

## ADR-028 — The event bus is the integration seam

**Decision.** Clinical actions publish `VisitEvent`s to a bus. Announcements,
notifications, the audit trail and telemetry are subscribers. The queue engine
knows about none of them.

**Why.** `visit.called` has to update the board, push the patient's tracker, fire
a browser notification, speak an announcement, write an audit entry and move the
analytics. Calling those six things from the action puts six concerns in one
place and makes each impossible to change alone. Adding WhatsApp later becomes a
new subscriber rather than an edit to the queue engine.

**A subscriber that throws cannot break the action.** The bus catches, counts the
failure and continues to the next subscriber. The clinical state change has
already committed and is not reversible by a downstream concern — a patient has
been called, and a failed announcement cannot un-call them. Failure counts are
surfaced in the Command Centre so a silently broken subscriber is visible rather
than merely survivable.

Events publish *after* the state change commits and after UI listeners run, so
no subscriber can observe an event for a change that has not landed.

---

## ADR-029 — Telemetry is scoped to patient flow, not infrastructure

**Decision.** QMan reports display-board connectivity, notification delivery
outcomes, and staff presence. It reports no CPU, memory, uptime or latency.

**Why.** The brief was explicit, and the line is a good one: monitoring servers
is the hospital IT department's job and a different product. What QMan uniquely
knows — and nobody else can report — is whether *patient flow* is working. Each
signal kept has a direct patient consequence:

- A dead display board is a room full of people who cannot see their number.
- A failing notification channel means patients missing their turn.
- An unstaffed queue will not clear on its own, and queue length alone does not
  reveal it.

Three details earned their complexity:

**Devices push; the server never polls.** A screen behind a hospital firewall is
usually not addressable, and the question is whether it is *rendering*, which
only the screen itself can answer.

**Two missed heartbeats before complaining.** A board that alarms on every flaky
wi-fi moment is a board nobody looks at.

**Declined permission is not a delivery failure.** A patient who refused
notifications is not a broken channel. Counting them as failures would keep the
panel permanently red and train managers to ignore it — so `denied` and
`unsupported` are reported separately and excluded from the failure rate.

**Presence is inferred from actions, not sessions.** A session says someone left
a tab open; calling a patient says they are at the desk. Only the second answers
"is Laboratory staffed right now".

---

## ADR-030 — One announcement string drives voice, notification and audit

**Decision.** `renderAnnouncement` produces a single string per event from a
configurable template. The spoken announcement, the browser notification body
and the audit entry all use it.

**Why.** Three separately-authored strings drift, and the drift surfaces as a
patient insisting they were told something different from what the record says.
One rendering means the patient hears, reads and can later verify identical
words.

Templates are configuration for the same reason queue numbers are: a hospital
calling "Ticket A-023" and one calling "Journey QM-8F4K" are both right.

**Announcements obey the display-board name policy** rather than carrying a
switch of their own — they are spoken aloud in the same public room, so the same
privacy rule applies. Where a template uses `{name}` under a ticket-only policy,
it falls back to the ticket rather than leaving a hole, so the sentence still
scans.

**Validation rejects an announcement that identifies nobody.** "Please proceed to
Consultation" with no ticket, journey code or name calls everybody in the room.

---

## ADR-031 — The Command Centre orders by patient impact

**Decision.** Alerts are ranked by consequence to patients, not grouped by
subsystem. An offline display board and an unstaffed queue rank alongside an SLA
breach; a failing notification channel ranks below them.

**Why.** A supervisor arriving at 10:30 has one question — what needs me — and
a screen that sorts by subsystem makes them assemble the answer themselves. The
ranking encodes a judgement: something already affecting a room full of people
outranks something that is still only a risk.

**The empty state is honest rather than reassuring.** With no board reporting,
the panel says "no board has reported in", not "all systems healthy". Telemetry
that reports health it cannot actually observe is worse than no telemetry,
because it is trusted.

---

## ADR-032 — Browser capabilities are ports, not direct calls

**Decision.** Speech synthesis, the Notification API and audio are each behind a
narrow port with a browser adapter. The announcement and notification logic
depends on the port, never on `window`.

**Why.** All three are absent in tests, absent on some devices, and behave
differently across browsers. Putting them behind ports means the product
decisions — what to say, who to tell, when to stay silent — are testable without
a browser, and a device that lacks a capability records an `unsupported` outcome
rather than throwing inside an event handler.

Chimes are synthesised from oscillators rather than shipped as audio files: a
two-tone chime is a few lines, and it keeps two binary assets out of a bundle
that a waiting-room screen loads over hospital wi-fi.

---

## ADR-033 — Announcements are serialised, and the board is the thing that speaks

**Decision.** Voice announcements queue and play one at a time. The subscriber
is registered only in the display-board app.

**Why.** Two patients called seconds apart at different stations would otherwise
be announced simultaneously, and the result is unintelligible — worse than
either announcement alone. Serialising costs a few hundred milliseconds of delay
and makes every announcement audible.

Registering it only on the board is a placement decision with the same
reasoning: the board is the surface with a speaker in a room full of patients. A
receptionist's laptop announcing "Ticket A-023" at the desk would be noise.

---

## ADR-034 — Notification permission is requested on a tap, never on load

**Decision.** The patient tracker asks for notification permission only when the
patient presses "Turn on alerts", and subscribes to events only after it is
granted.

**Why.** A permission prompt that appears before the patient understands what it
is for gets dismissed — and a dismissed prompt cannot be asked again in most
browsers. That spends the single chance to enable the feature that lets them
leave their seat on a dialogue they had no reason to accept.

Two consequences follow. `requireInteraction` is set on "it's your turn", so a
patient glancing down thirty seconds late still sees it. And one notification
`tag` per visit means a recall *replaces* the previous notification rather than
stacking a second one.

---

## ADR-035 — The tracker caches its shell but never its queue state

**Decision.** The service worker precaches the app shell and hashed assets;
navigations are network-first. Nothing carrying queue state is served from cache.

**Why.** A stale queue position is worse than no queue position. A patient who
reads "you are next" from a two-minute-old cache and misses their turn suffers
exactly the failure this product exists to prevent. Caching the shell buys fast
opening on a poor connection; caching state would buy a wrong answer.

Installability matters more here than it usually does: a patient who scanned a
QR code once has no bookmark and no way back if they close the tab.

---

## ADR-036 — The ticket is a template, and the element list is closed

**Decision.** Printed tickets are configured per hospital: paper size, which
elements appear and in what order, and the wording around them. The set of
elements is a closed union, not free-form layout.

**Why.** A 58 mm roll at reception, an 80 mm roll at triage and an A4 sheet in a
consulting room are all real, and one hardcoded layout is wrong on two of them.
So the layout is configuration.

But *fully* free-form composition is the wrong freedom. A ticket is the one
artefact a patient carries out of the building; an administrator who omits the
journey code breaks tracking silently, and it is discovered when a patient
cannot find their visit. A closed element set means every configuration is
coherent, and validation can insist on the two things that must be true:

- A ticket must carry the queue number or the journey code, or the patient has
  nothing to be called by.
- A QR code must be accompanied by the printed journey code, because a patient
  whose camera will not scan must still be able to type it.

Narrow rolls additionally reject over-long prose, which otherwise wraps into an
unreadable block and wastes paper on every visit.

**The ticket obeys the hospital's name policy** rather than carrying its own
switch — a ticket can be dropped in a corridor.

---

## ADR-037 — QR codes use a library and render as inline SVG

**Decision.** `qrcode-generator` (~10 kB, no dependencies) rather than a
hand-rolled encoder, rendered as inline SVG rather than canvas or a data URI.

**Why.** QR encoding is Reed-Solomon error correction, version selection and
mask evaluation. A subtle bug produces a code that scans on the developer's
phone and fails on a patient's — the worst kind of defect, because it looks
fine. This is not a reasonable thing to reimplement for a product patients rely
on.

Inline SVG stays crisp on a thermal printer at any size, prints reliably where
canvases frequently do not, and needs no image request. The code carries an
opaque white background because thermal paper is not always white and a QR over
a transparent area scans unreliably. Error correction is level M: a printed
ticket picks up fading and thumbprints, and M tolerates ~15% damage while
staying compact enough for a 58 mm roll.

---

## ADR-038 — Printing goes through an isolated iframe

**Decision.** The print dialogue shows the ticket for review, then prints via a
hidden iframe carrying only the ticket markup and its own `@page` rule.

**Why.** `window.print()` on the page would inherit the application's layout,
fonts and theme — a dark-mode ticket, at page width, is what comes out. An
iframe with `@page { size: 72mm auto }` is what makes a thermal roll print at
roll width.

Showing the ticket first is the same argument as any destructive confirmation: a
mis-printed thermal ticket is paper in the bin and a patient holding the wrong
number. The receptionist sees whose ticket is coming out, and which roll it
expects, before anything moves.

Colour is forced exact in print CSS, because thermal printers render greys as
dither patterns and a dithered QR code does not scan.

---

## ADR-039 — Ticket elements carry conditions

**Decision.** Each element on a ticket has a condition: `always`, `if_present`,
or `if_multiple_branches`.

**Why.** Without it, every small variation needs its own template — one for
single-branch sites, one for when a clinician is assigned, one for when a room
is known. Conditions collapse those into one template that adapts.

Validation had to sharpen with it: an identifier only satisfies the
"patient must have something to be called by" rule if it prints **unconditionally**.
A journey code set to "only when known" would pass a naive check while still
leaving some tickets blank.

---

## ADR-040 — Authentication is a port before it is a feature

**Decision.** `IdentityProvider` is the interface; local password auth is one
implementation. Providers are either `password` (credentials submitted directly)
or `redirect` (browser handed to an external service and returning) — the two
shapes SSO, OAuth, OIDC and SAML all take.

**Why.** QMan will not be the system of record for hospital identity for long.
Any hospital large enough to want it already runs a directory, and their first
question is whether staff need another password. Designing local auth as *the*
design would mean rebuilding the sign-in path, the session model and every
permission check to add SSO. As a port, adding SAML adds a provider and touches
no screen.

**Lockout lives in the store, not the provider**, so it protects every provider
equally — including ones added later that have no idea it exists.

**Authorization did not change.** Sessions resolve to a role, and the existing
`Permission` catalogue and `RoleConfig` model remain the authority on what that
role may do.

---

## ADR-041 — Password rules are short, and length outweighs variety

**Decision.** Minimum length, a small deny-list, and a block on including the
username. No forced rotation, no character-class quotas. The strength meter
takes three of its four points from length.

**Why.** Elaborate composition rules are well documented to make passwords
worse: people satisfy them with `Password1!` and write it on a note stuck to the
reception monitor. Length is what actually resists guessing.

The scoring was wrong on the first attempt — a point per character class rated
`Ab1!Ab1!Ab` above a twenty-nine character passphrase, which teaches exactly the
wrong lesson. A test caught the contradiction between the stated intent and the
implementation, and the implementation was fixed.

---

## ADR-042 — Sessions are generous, visible, and remotely terminable

**Decision.** Twelve hours idle, twenty-four absolute. Administrators see every
session — user, device, sign-in time, last activity — and can end any of them.

**Why the timeout is long.** A clinical shift runs eight to twelve hours, and a
doctor signed out mid-consultation because they spent forty minutes with a
patient is a system staff will *work around* — by disabling the timeout, or by
sharing a login that never locks. A timeout short enough to be a nuisance
produces worse security than one long enough to be tolerated.

**Why remote termination is Version 1.** The reason given for including it: a
reception workstation left signed in overnight. Without this the only remedy is
walking to the machine. That is an operational necessity, not an enterprise
luxury.

Ended sessions stay listed rather than vanishing — "who was signed in on that
machine, and who ended it" is worth being able to answer.

---

## ADR-043 — Relational storage plus a durable business event log

**Decision.** Visits, queue entries, configuration, users and sessions are
ordinary relational rows and are the working state. Alongside them, `events`
stores every business event as a permanent record with its own sequence,
category, payload and pre-rendered summary.

Explicitly **not** event sourcing and **not** CQRS. State is read from the state
tables, never rebuilt from a stream.

**Why.** Event sourcing would buy perfect reconstruction and cost a rebuild on
every read, a projection-rebuild story, and a class of bug that only appears
under replay. QMan does not need it. What it does need is the history — who
called whom, when a patient was routed, who changed the SLA — and that is a log,
not an architecture.

Treating events as records rather than as messages is the whole point: they
outlive the subscriber that reacted to them, and the audit trail, activity
timeline and future analytics are all reads against one table.

**The summary is rendered at write time.** History then reads as it did when it
happened, and the explorer needs no domain logic to display a two-year-old
record. Re-rendering on read would mean a renamed station silently rewrites the
past.

---

## ADR-044 — Nothing derivable is stored

**Decision.** No table for queue position, worklists, SLA status, bottlenecks,
channel health or any dashboard figure. All are computed from the rows above.

**Why.** A stored projection is a copy, and the moment it disagrees with its
source nobody can say which is right. Queue position is the sharpest case: it
changes every time anyone is called, so storing it means one call writes to
every other waiting visit, and a single missed write leaves a patient reading a
stale number on their phone (ADR-020).

The cost is real — every worklist read recomputes — and the schema is indexed
for it: partial indexes on open queue entries and on each event category carry
the queries these projections actually issue.

**Two things that look derived and are not.** `visits.current_queue_entry_id` is
the aggregate's own record of where a visit is, not a cache. And
`queue_entries.queue_label` is the ticket *as issued*, stored precisely so it
cannot be re-derived under a later format (ADR-018).

---

## ADR-045 — Mapping is hand-written and total

**Decision.** No ORM. Row types are declared explicitly and mapped by hand, and
every enum-shaped column is validated on the way in, throwing a `MappingError`
naming the table, column, row id and value.

**Why.** An ORM infers most of this and would also happily hand back a visit
whose `status` column holds a value the state machine has never heard of. That
surfaces later as a visit nobody can act on, in production, with a patient
waiting. Failing at the boundary — where the message can name the offending row
— is far cheaper.

It also keeps the SQL legible. The indexes above exist because someone chose
them for a known query, not because a query builder emitted something.

---

## ADR-046 — Repositories are written against a one-method SQL port

**Decision.** Every repository depends on `SqlExecutor` (`query(sql, params)`)
and `Transactional`. A `FakeDatabase` records statements and returns queued rows.

**Why.** This development environment has no Postgres, and code that can only be
exercised against infrastructure nobody has is code that ships unverified. The
port makes the part that actually carries bugs testable: which statements a
repository issues, in what order, with which parameters, inside which
transaction.

Those tests now assert things worth asserting — that saving a visit writes its
rows and its events under one commit; that `created_at` and `journey_code` are
excluded from the upsert; that loading forty visits is two queries and not
forty-one; that a search term is parameterised rather than interpolated.

They are not a substitute for running against a real database. Integration tests
against Postgres remain outstanding, and are listed as such.

---

## ADR-047 — Activity and Audit are two screens, not one filter

**Decision.** Operational history and administrative history are separate tabs
over the same table, split by `category`. Activity reads as a feed or a journey;
Audit reads as a table.

**Why.** They answer different questions for different people. "Where has this
patient been, and who transferred them" is asked by a supervisor tracing a
complaint. "Who changed this SLA, and when" is asked by an administrator, or by
whoever turns up wanting to know how a setting came to be what it is.

Merged, neither is findable: a hundred patient calls bury the one configuration
change that mattered. The split is also why the shapes differ — a journey is a
sequence and reads best in order, while an audit question is comparative and
reads best as a table.

**Refused changes record nothing.** A configuration write that validation
rejects produces no audit entry. A trail that records changes which did not
happen is worse than no trail, because it is trusted.

**Failed sign-ins record no actor.** A failed attempt has not proved who it was;
attributing it would put a name against someone else's mistyped password.

---

## ADR-048 — Correlation travels on the event

**Decision.** `journeyCode` is part of the event envelope, stamped by the
aggregate onto every event it emits — not just `visit.created`. Administrative
and security events correlate by session id instead.

**Why.** The first implementation had the audit subscriber remember each
Journey Code from `visit.created` and apply it to later events. A test exposed
the flaw: any subscriber that starts late, restarts, or receives events from
another process has no such memory, and correlation silently becomes null.
Correlation that is only sometimes present is correlation nobody can rely on
during an investigation — which is the only time it is used.

Carrying it on the envelope makes it structural. The aggregate stamps it in one
place, so no call site can forget, and the API can hand events to a browser over
a socket with correlation intact.

**The Journey Code is the right key** because it is the identifier the
investigator already has: printed on the ticket, spoken at the desk, known to
the patient. Matching is case-insensitive, since it is typed off paper by a
human.

---

## ADR-049 — A live surface must never lie about being live

**Decision.** Connection state is a five-value domain model — `connecting`,
`connected`, `reconnecting`, `stale`, `offline` — shared by every real-time
surface, with a `trustworthy` flag and a freshness line ("Updated 2m 14s ago").
The display board's unconditional "Live" badge is gone.

**Why.** The board previously asserted "Live" whether or not it was receiving
anything. If its source went quiet it kept rendering the last queue it had,
still claiming to be current, while patients were called without it.

That is not a UX flaw. In a clinical setting, **stale information presented as
current is more dangerous than no information at all**, because it is acted
upon: a patient reads a frozen board, concludes they are still four back, and
misses their turn. It is the same principle the Command Centre already followed
(ADR-031) — telemetry reporting health it cannot observe is worse than none —
applied to the surface that most needed it.

**One model for every surface**, not a board-specific patch, so a board, a
station terminal, the tracker and the command centre all answer the question the
same way.

Three details earned their place:

- **Two missed beats before doubting.** 45 seconds of silence, matching the
  device-health thresholds, so a wi-fi stumble in a corridor does not cry wolf.
- **Only a healthy connection pulses.** A frozen board with a cheerful blinking
  dot is exactly the lie being removed.
- **A stale board keeps showing the queue.** Something clearly labelled as
  possibly out of date beats a blank screen; the label is what makes it safe.

Wording is for patients, not engineers: "Data may be outdated", not "stale";
"Connection lost. Please ask at reception", not "offline".

**Freshness needed a heartbeat, not a version.** `ClinicStore.version` changes
only when the clinic changes, so a quiet half-hour would be indistinguishable
from a dead connection. `heartbeat` also advances on a keepalive, answering "is
the source still there" rather than "has anything happened".

---

## ADR-050 — A ticket number, once issued, is never reissued

**Decision.** Ticket ordinals are recovered, never reset. `QueueTicket` carries
its `periodKey`, stored on the queue entry; after a restore, each series is
advanced past the highest ordinal known to have been issued — from the restored
rows and from any paper tickets written during the outage.

**Why.** A point-in-time restore rewinds the allocator but not the waiting room:

```
13:58  A-042 printed and handed to a patient
14:00  power failure
14:05  restore to 13:55
14:06  allocator issues … A-042
```

Two people then legitimately hold A-042. There is no good way to explain that to
either of them, and it undermines every number on the board — the one thing a
queue system must be trusted about.

Three design consequences:

- **`recoveredOrdinal` returns the next safe ordinal, not the high-water mark**,
  so a caller cannot accidentally set a counter to a number still in someone's
  hand.
- **`advanceTo` uses `GREATEST`/`Math.max`.** Recovery run twice, or with a
  stale figure, must never wind a series backwards — the only thing it exists to
  prevent.
- **`periodKey` is stored on the entry** rather than re-derived at recovery
  time. Re-deriving it from current configuration would guess wrong if the reset
  strategy had changed since, and a wrong guess reissues numbers.

**Paper tickets need a human.** `needsReconciliation` returns true until staff
supply the highest number they wrote by hand — only they know. An explicit zero
("we issued none") is different from nobody having checked, and the model
distinguishes them.

---

## Findings in the Stitch designs

Recorded rather than silently "fixed", since some are product decisions.

1. **Two different code schemes.** The Reception Dashboard shows `QM-8F4K`; the
   Clinical Workspace shows `A-402`, `C-112`, `B-201` and also labels them
   "Code". These are different things and the model already separates them: the
   **Journey Code** (`QM-8F4K`) is the visit's identity for its whole journey,
   while `A-402` is a per-station queue number. Implemented accordingly —
   Journey Code identifies, queue number is what gets called at a station.

2. **The station load chip clipped.** In the Live Queue Status cards, a longer
   station name pushed the count chip out of its card ("5 WAITIN"). Fixed: the
   name truncates and the chip never shrinks, so the count is always legible.

3. **The Department Load chart renders empty.** The manager dashboard's chart had
   axes and labels but no bars. **Resolved**: replaced with a queue-length
   breakdown per station, coloured by SLA status, that reads at a glance and
   carries average wait and average service time alongside each bar.

4. **Recent Visits can hide an emergency.** The table is ordered strictly by
   arrival, so an emergency patient who arrived before the six most recent
   walk-ins does not appear. Correct for a list labelled "recent"; questionable
   for patient safety. **Resolved** by ADR-015: a dedicated Priority Patients
   section above the table, with Recent Visits left chronological.

---

## Open items

- **Queue-number allocation** is supplied to the aggregate by the caller. The
  domain declares the `OrdinalAllocator` port and ships an in-memory reference
  implementation which is correct for a single process and deliberately not for
  more — the production implementation must make it atomic, or two receptions
  admitting patients simultaneously will both be issued `A-014`.
- **Notifications on call.** The events exist (`visit.called`, `visit.queued`,
  `visit.routed`) and carry everything a message needs. Delivery channels — SMS,
  WhatsApp, push, browser — are not built. Per direction, these can be added as
  event subscribers without changing the event architecture.
- **QR code generation.** The tracker accepts `?code=`, so the URL contract is
  settled, but nothing renders the QR image onto a printed ticket yet.
- **Users.** Roles and permissions are modelled and editable; assigning people to
  them needs authentication and persistence, both deferred.
- **Multi-branch.** The model carries branches, but each branch owning its own
  stations, workflows and boards needs persistence to be meaningful.
- **Notification templates** are not yet part of the configuration model; they
  arrive with the delivery channels.
- **Operational Command Centre.** Agreed as the next major module. Some inputs
  it needs do not exist yet: display-board connectivity, staff presence, and
  notification delivery outcomes are all things nothing currently reports.
- **Postgres integration tests.** The schema, mappers and repository SQL are
  written and unit-tested against a recording fake, but nothing has run against
  a real database — there is no Docker or `psql` in this environment. Before
  pilot: apply `001_initial.sql` to a real instance and run the repositories
  against it. This is the largest single piece of unverified work in the repo.
- **Wiring persistence into the app.** The browser stores still hold state in
  memory. Swapping them for the repositories is the next step, and is the point
  at which the local password provider must move server-side (ADR-040).
- **Priority weights** are currently a frozen default. Making them per-hospital
  configuration is a small change and is why they are weights.
- **Postgres is unverified.** Neither Docker nor `psql` is available in the
  development environment, so no persistence code can be executed or
  integration-tested yet.
- **Remaining screens.** Clinical Workspace, Manager Dashboard and Patient
  Journey Tracking are designed but not built. The primitives they need
  (`JourneyTimeline`, `JourneyCode`, `ActionButton`, `StatCard`) already exist.
