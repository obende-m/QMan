# QMan Operational Runbook

For the people running the clinic — reception, nursing, station staff and the
duty manager. Not a developer document.

Keep a printed copy at reception. The section you will need most is the one for
when QMan is unavailable, and you will not be able to read it on screen.

---

## Daily startup

Ten minutes before the first patient.

1. **Server** — confirm QMan is reachable. Open the staff app and sign in.
2. **Display boards** — walk past each screen. Each must show a green **Live**
   badge. Anything else means the board is not receiving updates:
   - *Reconnecting…* — wait one minute; it usually recovers on its own.
   - *Data may be outdated* / *Connection lost* — reload the board page. If it
     does not recover, check the screen's network cable or wi-fi.
3. **Printer** — print one test ticket from reception. Check that:
   - the whole ticket fits the paper width, nothing clipped;
   - the queue number is large and legible at arm's length;
   - the QR code scans with a phone camera.
4. **Queue numbering** — confirm the first ticket of the day starts where you
   expect. A daily-reset station should begin at 001.
5. **Sign-in** — confirm each staffed station can sign in. Sort this now rather
   than with a patient at the desk.

If any check fails, see *Common problems* before opening.

---

## During the day

### Calling patients

- **Call next** — press *Call Next*, or the **N** key.
- **Recall** — press **R**. Use when a patient has not come forward. The
  announcement repeats and says "Repeat".
- **Skip** — press **K**. Use when a patient does not answer after a recall.
  They keep their place and their arrival time; they are not sent to the back
  and they are not removed. Call them again later.
- **Start** — press **S** when you begin seeing the patient. This is what makes
  waiting-time and service-time reporting accurate; skipping it does not break
  anything but does distort the numbers.
- **Complete** — press **C** when the patient's visit is finished entirely.
- **Send to…** — use the buttons under the patient card. Only the destinations
  the workflow allows are offered. If the one you need is missing, the workflow
  needs changing in Administration — do not work around it.

### Escalating

Press **E**, or use *Escalate*, to raise a patient to Emergency. They move to
the front of every queue they are in. Emergency and Urgent patients also appear
in **Priority Patients** on the Reception dashboard regardless of when they
arrived.

### Reopening a completed visit

If a patient was completed by mistake, or needs to be seen again — a result has
come back, a clinician wants them returned — open the visit and route them to a
station. A completed visit can be sent back into a queue without being
re-registered, so they keep their Journey Code and their history.

### A patient has lost their ticket

Search their name or hospital number in the staff app. Their Journey Code
(`QM-…`) is on the visit; give it to them, or reprint the ticket. **Do not
register them again** — a second visit means a second place in the queue and
two records of the same person.

### A patient asks how long

The Patient Tracker shows their position, the number of people ahead and an
estimated wait. They can reach it by scanning the QR on their ticket, or at the
tracking address with their Journey Code. Estimates are deliberately cautious:
patients are usually seen a little earlier than told.

---

## Common problems

### A display board shows anything other than "Live"

The board is showing what it last received. **It may be out of date, and it
says so.** Patients reading it may be looking at an old queue.

1. Reload the board page.
2. Check that machine's network.
3. If it will not recover, switch that waiting area to calling patients by
   voice until it does, and tell reception so they can warn patients.

A board that is showing *Connection lost* is safer than one silently frozen —
but it still needs fixing before patients start missing their turn.

### The printer jams or runs out

1. Clear the jam or replace the roll.
2. Reprint the ticket from the visit — do not create a new visit.
3. If the printer cannot be recovered, switch that desk to **paper tickets**
   (below) while keeping QMan running for everything else. Write the QMan queue
   number on the paper ticket so the two agree.

### Patients are not receiving notifications

Notification delivery is shown in the **Command Centre**. If a channel is
reported as failing, patients are not being told when it is their turn — call
them by voice and tell reception to advise patients to watch the board.

### A station has a queue but nobody serving it

The Command Centre reports this directly. It will not clear itself. Assign
someone or redirect the queue.

### Somebody left a workstation signed in

Administration → Sessions. Find the machine, press *End session*. You do not
need to go to the machine.

---

## When QMan is unavailable

**Do not stop seeing patients.** QMan manages the queue; it does not deliver
care.

### Switch to paper immediately

1. Reception issues **hand-written tickets**, continuing the same series each
   station was on. If Consultation had reached `A-042`, the next paper ticket is
   `A-043`.
2. Keep a **running sheet per station**: ticket number, patient name, arrival
   time, and where they were sent. This sheet is what recovery depends on —
   without it, the queue cannot be rebuilt.
3. **Record the highest ticket number issued on paper at each station.** Circle
   it at the bottom of the sheet. This single number is what prevents two
   patients being given the same ticket after recovery.
4. Stations continue calling patients by voice, in ticket order.
5. Tell waiting patients what has happened and that their place is kept. Most
   complaints after an outage are about not being told, not about the wait.

### While down

- Do not restart the server yourself unless IT has asked you to.
- Note the time the outage started.
- Keep the running sheets together at reception.

---

## Recovery and reconciliation

When QMan comes back, **it will not know about anything that happened on paper**,
and it may have lost the last few minutes before the outage.

Work through this before the next patient is called.

### 1. Check what the system thinks

Open the Reception dashboard. Compare against your running sheets:

- Patients QMan does not know about — they arrived during the outage.
- Patients QMan still shows as waiting who have already been seen or gone home.

### 2. Fix the ticket numbering — do this first

**A ticket number, once given to a patient, is never given to anyone else.**

For each station, tell your administrator the **highest ticket number issued on
paper** (the number you circled). They will advance that station's series past
it.

Until this is done, do not issue new tickets from QMan. If you do, someone in
the waiting room will be holding the same number as someone at the desk, and
there is no good way to explain that to either of them.

### 3. Re-admit patients who arrived during the outage

Register each one, in the order they arrived, and give them their paper ticket
number where possible. If the number cannot be preserved, hand them a new ticket
**and tell them their number has changed** — do not let them discover it from
the board.

### 4. Close out patients who are no longer here

Complete or cancel any visit QMan still shows as waiting for someone who has
been seen or has left. Leaving them in place distorts every wait-time figure for
the rest of the day and leaves ghost patients on the boards.

### 5. Confirm the boards

Every board back to **Live**. Confirm the queue on each screen matches the room.

### 6. Note it

Record in the day's notes: outage start and end, stations affected, roughly how
many patients were handled on paper. This is what makes the next outage shorter.

---

## End of day

1. **Queues empty** — every station should show no waiting patients. Anything
   left is a patient who was never completed; close them out.
2. **Alerts** — check the Command Centre. Note anything that was breaching, so
   tomorrow's staffing can account for it.
3. **Backup** — confirm the day's backup completed. *A backup nobody checks is
   not a backup.*
4. **Sign out shared workstations** — reception and any shared station machine.
   Administration → Sessions shows anything left signed in.
5. **Boards** — leave them running; they will pick up tomorrow automatically.

---

## Who to call

| Problem | First action | Then |
| --- | --- | --- |
| Board offline | Reload the page | Hospital IT |
| Printer failed | Paper tickets | Hospital IT |
| Cannot sign in | Check with another user | Your QMan administrator |
| QMan unreachable | Switch to paper | Hospital IT, then your administrator |
| Wrong queue numbers after an outage | **Stop issuing tickets** | Your administrator |

Fill in names and numbers before the pilot begins, and pin this to the wall.
