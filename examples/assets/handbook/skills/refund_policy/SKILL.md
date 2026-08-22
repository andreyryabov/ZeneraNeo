---
name: refund_policy
description: When a refund is owed, how much of it, and who has to approve it
tags: [refunds, policy]
tools: [refund_quote]
version: 2.0.1
---

Refunds are decided by how long ago the order was delivered.

| Days since delivery | Outcome                                       |
| ------------------- | --------------------------------------------- |
| 0–30                | Full refund, no questions asked               |
| 31–90               | Store credit only, minus a 10% restocking fee |
| 91+                 | No refund; offer a repair                     |

Faulty goods ignore the table: they are always a full refund, at any age.

Call `refund_quote` to compute the amount. Do not do the arithmetic yourself —
the tool is the system of record and its number is the one the customer gets.

Refunds above 500 EUR need a supervisor. Say so instead of confirming them.

`matrix.csv` in this skill folder holds the same table in machine-readable form.
