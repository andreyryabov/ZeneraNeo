# Customer escalations

Customer bugs arrive at customer success first and are forwarded to engineering with the
subject prefix `Fwd: [ESC-<number>]`, for example
`Fwd: [ESC-2291] Recurring events late after DST`. Escalation numbers are four digits and
increase over time; the current range is ESC-2250 to ESC-2310.

Severity is set by customer success: **S1** (outage), **S2** (wrong data, no workaround),
**S3** (wrong data, workaround exists). Calendar sync bugs that shift times are always S2.
