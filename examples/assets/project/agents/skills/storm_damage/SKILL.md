---
name: storm_damage
description: Wind, hail and falling-tree damage — what counts as a storm and what is excluded
tags: [peril, weather]
tools: [damage_estimate]
version: 3.1.0
---

A storm means a gust recorded at 55 mph or more, or hail of 20 mm or more,
within 48 hours of the damage. Below that threshold the cause is wear, not
weather, and the claim falls under maintenance instead.

Covered: roof coverings, windows, external doors, fences attached to the
building, and anything inside the building that got wet because the storm
opened it up.

Excluded: free-standing fences and gates, garden structures, and any roof that
was already the subject of a maintenance notice.

The excess is 500 EUR for a storm claim, or 1000 EUR if the same property has
claimed for storm damage within the previous 24 months.

Call `damage_estimate` for the settlement figure. The tool applies the excess
and the depreciation schedule; do not do either by hand.
