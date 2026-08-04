# On-call

§12.2 asks for this to be "defined, even informally for a small team — who
gets paged, for what severity, and what the response-time expectation is."

This is that document. It is deliberately short, and it is deliberately written
before there is a team, because the alternative is deciding what counts as an
emergency while one is happening.

## What pages, and why

Severity is decided in code, in `packages/observability/src/reporter.ts`. That
file is the authority; this section explains its reasoning so the two do not
drift.

| Severity | Meaning | Delivery |
|---|---|---|
| `page` | Something is broken and a human is needed now | Phone |
| `warn` | Unexpected, worth looking at today | Chat/email |
| `routine` | Expected failure. Logged, never alerted | Logs only |

**The default for an unrecognised error is `page`.** Anything reaching the
handler that nobody classified is, by definition, something nobody thought
about.

**Correct refusals are never paged.** A locum applying to a filled shift, an
outsider poking at a booking, an expired session — these are the system
working. A pager that fires on correct behaviour gets muted, and then the one
that mattered arrives silently. That failure mode is the reason `classify`
exists at all.

**One domain error pages anyway:** `REFRESH_TOKEN_REUSED`. §12.1 kills the
session on a replayed refresh token — correct behaviour, and simultaneously the
strongest signal available that someone's credentials were stolen.

## Response expectations

Deliberately modest. An expectation nobody can meet is not a policy, it is a
way of feeling organised.

| Severity | Acknowledge within | Notes |
|---|---|---|
| `page` | 30 minutes, 06:00–22:00 SAST | Outside those hours, best effort |
| `warn` | Next working day | |
| `routine` | Never | Reviewed only when investigating something else |

The 06:00 start is not arbitrary: pharmacies open early, and a booking system
that is broken at 06:30 is broken at exactly the moment it matters most.

## The failures that will never page you

This is the part worth reading twice. Three of the worst things that can happen
to this product raise no exception at all, so no amount of error alerting will
catch them. They are visible only on `/admin/dashboard`:

1. **A shift that started unfilled.** Nothing errored. No alert fired. A
   pharmacy opened without a pharmacist.
2. **A deferred message past due and undrained.** The §4.4 quiet-hours queue
   silently not draining looks, from every internal indicator, like a quiet
   morning.
3. **A charge with no answer from the provider.** Money may have moved. §2
   treats this as unresolved rather than failed for exactly that reason, and it
   stays unresolved until a reconciliation lookup succeeds.

Check the dashboard daily. It is not decoration; it covers a class of failure
the pager structurally cannot.

## Testing the pager

`make drill` fires the §0.1 deliberately broken endpoint against a target with
`DRILL_ENABLED=true`, which production refuses to boot with. It is rate-limited
to one firing per minute — a drill that pages fifty times has proven the pager
works and spent the goodwill needed for the next real page.

Run it after any change to alert routing, and after onboarding whoever is next
on the rota. §15 is clear that this gate closes when a phone actually buzzes,
not when the code is merged.

## Who

To be filled in when there is more than one person. Until then: whoever is
reading this.

Leaving this section honest rather than inventing a rota is the point — a
policy naming people who have not agreed to it is worse than one that admits
the rota does not exist yet.
