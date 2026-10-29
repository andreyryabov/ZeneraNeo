# Tempo release process

A release goes through four sign-offs, tracked in the launch checklist by the PM:

1. **Engineering** — the engineering lead confirms every release blocker is closed.
2. **QA** — the regression suite is green on the release candidate (`rc.N`).
3. **Design** — final assets (banners, in-app announcement) are approved.
4. **Support** — customer success has the release notes and the known-issues list.

Release candidates are tagged `tempo-4.0.0-rc.N`. CI posts failures from
`ci@northwind.io` with subjects like `[CI] tempo-4.0.0-rc.7 failed — <suite>`.

A **go/no-go** meeting is held the working day before launch. It needs the PM, the
engineering lead and the platform staff engineer.
