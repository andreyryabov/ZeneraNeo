---
name: preferential_origin
description: Reduced or zero duty when the goods qualify under a trade agreement
tags: [customs, duty, origin]
tools: [duty_quote]
version: 1.1.0
---

A trade agreement can drop the duty to zero, but only for goods that
**originate** in the partner country. Shipped from is not originated in: goods
that merely passed through a partner's warehouse do not qualify.

The claim must be supported at the time of declaration:

- a statement on origin from the exporter, or
- the importer's own knowledge, documented.

Without one of those, the shipment falls back to the standard third-country
rate — the claim is not something to assume on the customer's behalf.

Call `duty_quote` with `regime: "preferential"` once the evidence is in hand.
