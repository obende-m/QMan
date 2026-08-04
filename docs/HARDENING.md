# Preparing QMan for Clinical Use

The objective has changed. It is no longer *build QMan* — every Version 1 module
is built and tested. It is now **prepare QMan for clinical use**, which is a
different job with a different definition of done.

Building asks "does it work?". Preparing for clinical use asks:

> When this fails at 2 p.m. on a Tuesday, with forty patients in the waiting
> room, what happens?

Nothing below adds a feature. Everything below is about whether QMan can be
trusted in a room with real patients in it.

**Priorities, in order:** Reliability · Security · Performance · Usability ·
Deployment · Documentation · Training · Operational readiness.

---

# 1. Reliability

## 1.1 Disaster recovery — the question that must have an answer

Hospitals tolerate bugs far better than they tolerate lost operational data. A
bug is an annoyance; a lost morning is forty patients whose place in the queue
no longer exists and who are all standing at the reception desk at once.

Before the pilot, these two numbers must be written down, agreed, and
**demonstrated** — not estimated:

| | Target | Demonstrated |
| --- | --- | --- |
| **RPO** — how much data can we lose? | ≤ 5 minutes | ☐ |
| **RTO** — how long until we are running again? | ≤ 30 minutes | ☐ |

- [ ] **Backup.** Nightly `pg_dump` plus continuous WAL archiving. The dump
      alone gives an RPO of up to 24 hours, which is a lost day of clinic —
      WAL archiving is what makes the 5-minute target real.
- [ ] **Restore.** Restore to a clean instance from backup and confirm the
      clinic is intact. *A backup that has never been restored is not a backup.*
      Time the restore and record it as the measured RTO.
- [ ] **Point-in-time recovery.** Restore to 13:59 having failed at 14:00, and
      confirm the visits, queue entries and event log are consistent with each
      other.
- [ ] **Migration rollback.** Every migration needs a tested down path, or an
      explicit decision that it is forward-only and a restore is the rollback.
      Decide which, per migration, and write it down.
- [ ] **Power failure.** Pull the plug on the database mid-write. Confirm
      Postgres recovers, and that no visit is left with queue entries but no
      visit row, or an event recorded for a state change that was rolled back.
- [ ] **Power failure, the rest of it.** Confirm the display board browser
      relaunches into the board unattended, workstations return to sign-in, and
      the thermal printer recovers without a manual reset.
- [ ] **Network interruption.** Sever the network between a workstation and the
      server mid-action. Confirm no duplicate ticket is issued and no visit is
      left half-routed.

## 1.2 The part disaster recovery documents usually miss

QMan's data describes people who are **physically in the building**. Restoring
the database is only half of recovery; the other half is reconciling with the
waiting room.

- [ ] **Write the paper fallback.** What reception does during an outage:
      hand-written tickets, a running list, which stations keep working. This
      belongs in the runbook and must be rehearsed once before the pilot, not
      invented during the first outage.
- [ ] **Write the reconciliation procedure.** After restore, some patients hold
      tickets QMan has never seen, and some visits in the database describe
      people who gave up and went home. Staff need a defined way to re-admit
      and to close out — ideally without needing an administrator.
- [x] **Ticket sequence after a restore — decided and implemented.** The rule
      is **a ticket number, once issued to a patient, is never reissued**
      (ADR-050). `reconcileSeries()` advances every series past the highest
      ordinal in the restored data; `advanceTo()` handles paper tickets, and
      never winds a series backwards. Remaining: run it against a real restore
      (§1.4), and rehearse the paper hand-off (§1.2).

## 1.3 Connection honesty — fixed

The display board previously showed **"Live"** unconditionally, continuing to
render a frozen queue under a green badge if its source went quiet.

- [x] **Fixed (ADR-049).** Connection state is now a shared five-value model
      across every real-time surface, with a freshness line. A stale board still
      shows the queue — something labelled as possibly out of date beats a blank
      screen — but stops claiming to be current, and only a healthy connection
      pulses.
- [x] **Applied to the patient tracker and the staff shell.** On the tracker a
      stale page also visibly caveats the position and wait figures, since those
      are what a patient acts on. In the staff shell the indicator appears only
      when degraded — a permanent green badge in a toolbar is one staff stop
      seeing.
- [ ] Confirm on real hardware that a board recovers its status after the
      network is pulled and restored.

## 1.4 Database verification — still the largest unverified area

**Nothing in `@qman/persistence` has run against a real database.** The unit
tests assert which SQL is issued; they cannot catch a DDL error, a wrong index,
or a constraint that behaves differently than expected.

- [ ] Apply `packages/persistence/migrations/001_initial.sql` to a clean
      PostgreSQL 14+ instance; confirm it applies in one transaction.
- [ ] Verify every constraint fires: the one-default-branch and
      active-journey-code partial indexes, `queue_entries_visit_sequence`, the
      workflow stage uniqueness pair, and each `CHECK`.
- [ ] Verify foreign keys and `ON DELETE` behaviour, especially `RESTRICT` on
      stations referenced by workflow stages.
- [ ] Run every repository against the real instance.
- [ ] **Concurrency: hammer `PostgresTicketAllocator` from parallel
      connections.** If this is wrong, two patients receive the same number, and
      it will only appear under load. This is the single most important
      correctness test in the layer.
- [ ] Kill a save between the visit insert and the event insert; confirm the
      transaction leaves nothing behind.
- [ ] Write and apply a second migration — verify the path, not just the create.

## 1.5 End-to-end behaviour

- [ ] Walk a full journey with real staff, including every exception: skip,
      recall, escalate, cancel, route off-workflow, reopen a completed visit.
- [ ] Confirm board, tracker and dashboards all follow each action with no
      refresh.
- [ ] Run a full day without restarting anything; confirm the daily queue reset
      rolls over correctly at midnight **in the hospital's timezone**.
- [ ] Confirm memory does not grow unbounded on a board left running for a week.

---

# 2. Security

- [ ] **Move authentication server-side.** The local provider verifies passwords
      in the browser (ADR-040). This must not reach a pilot — hashes cannot be
      sent to a client. The port exists; the implementation becomes an HTTP
      call. **Blocking.**
- [ ] **Enforce permissions at the API.** Current gating hides controls in the
      UI, which is a courtesy and not enforcement.
- [ ] Rate-limit sign-in server-side; the present lockout is client-side and
      advisory.
- [ ] Review what the patient tracker exposes to an unauthenticated visitor
      holding only a Journey Code.
- [ ] Confirm no patient identity can reach the display board or manager
      dashboard under **any** configuration.
- [ ] Confirm every administrative mutation produces an audit record, and that
      audit records cannot be deleted through the application.
- [ ] Confirm backups are encrypted at rest and access to them is restricted —
      a backup is a complete copy of the patient flow record.

---

# 3. Performance

- [ ] Seed a month of representative data (~200 visits/day) and profile the
      worklist, reception list and audit explorer queries.
- [ ] Confirm the display board holds a stable frame rate over hours.
- [ ] Measure patient tracker load on a throttled mobile connection.
- [ ] Establish the concurrency ceiling: how many simultaneous stations and
      boards before anything degrades.

---

# 4. Usability

- [ ] **Accessibility review.** Some groundwork exists — focus is never removed,
      `aria-live` carries action feedback, meters expose queue depth,
      reduced-motion is honoured — but it has not been reviewed properly.
      Keyboard-only walkthrough of every staff screen; NVDA pass over reception,
      the station workspace and the tracker; contrast audit in both themes;
      tracker usable at 200% zoom.
- [ ] **Printing on real hardware.** 58 mm and 80 mm thermal, and A4. Confirm
      the QR scans from a *printed* ticket — after slight thermal fade, on an
      older phone camera.
- [ ] **Browser compatibility.** Chrome and Edge on Windows for staff; Safari on
      iOS and Chrome on Android for the tracker, on low-end devices; whatever
      browser the waiting-room screen actually runs.
- [ ] Confirm PWA installation works on both mobile platforms and notifications
      survive install.
- [ ] Confirm speech synthesis voices exist for the configured language on the
      board's machine.
- [ ] Real clinic walkthrough with a receptionist, a nurse and a doctor — watch,
      do not demo.

---

# 5. Deployment

- [ ] Serve all three apps behind one origin.
- [ ] Container images and a single-site `docker-compose`.
- [ ] Configuration through environment, never code.
- [ ] Wire persistence into the application: replace the in-memory stores with
      repository calls behind the same interfaces; move sessions to the
      `sessions` table; persist events in the same transaction as the state
      change.

---

# 6. Documentation

- [ ] Installation and deployment guide.
- [ ] Administrator guide: stations, workflows, queue numbering, boards,
      announcements, tickets, roles.
- [ ] Staff quick reference, including keyboard shortcuts.
- [ ] **Runbook**, covering at minimum: board offline, printer failed,
      notifications not delivering, server down (with the paper fallback), and
      post-outage reconciliation.

---

# 7. Training

- [ ] Configure the pilot clinic **through the Administration Portal only**. If
      anything requires a developer, that is a bug in the portal, not a task.
- [ ] Staff onboarding session per role, using their own accounts.
- [ ] Rehearse the outage procedure once, before it is needed.

---

# 8. Operational readiness

- [ ] Agree what "success" means for the pilot before it starts, and how it will
      be measured.
- [ ] Agree who is on call, and what they are called for.
- [ ] Confirm the fallback plan is understood by the staff who would use it, not
      only by the people who wrote it.
- [ ] Set a review date after week one.

---

## Known gaps carried in

Recorded rather than quietly closed:

- Postgres is unverified (§1.4).
- Browser-side password verification must move server-side (§2).
- Permission enforcement is UI-only (§2).
- The display board is a separate bundle from the staff app, so cross-surface
  updates need the API before "live" means live across screens (§5).
- Multi-branch is modelled but only exercised single-branch.
- SMS, WhatsApp and email are modelled in telemetry but not implemented.
- HMS integration is deliberately out of scope for Version 1.
