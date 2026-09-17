---
name: hs_classification
description: Assigning a Harmonized System code to a shipment before it can be valued
tags: [customs, classification]
tools: [hs_code_lookup]
version: 1.3.0
---

Nothing about a shipment can be quoted until it has an HS code. The code is not
a description of the goods, it is a legal classification, and two products a
catalogue would shelve together often sit in different chapters.

Rules that decide the hard cases:

- Classify by **what the thing is**, not what it is used for. A steel bracket
  sold for bicycles is a steel article, not a bicycle part.
- A set packaged for retail sale takes the code of the component that gives it
  its essential character.
- When two codes both fit, the more specific one wins.

Call `hs_code_lookup` with a plain description of the goods. Never invent a
code: an invented code clears customs right up until it does not, and the
penalty lands on the importer.
