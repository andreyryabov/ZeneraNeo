---
name: duty_calculation
description: Standard third-country duty on a shipment that claims no trade agreement
tags: [customs, duty]
tools: [duty_quote]
version: 2.0.0
---

The ordinary case: goods arrive from a country the importing bloc has no
preferential arrangement with, so the full third-country rate applies to the
customs value.

Customs value is the price paid **plus** freight and insurance to the border.
Importers routinely quote the invoice total and forget the freight, which
understates the duty and turns into an amended declaration later.

Call `duty_quote` with `regime: "standard"`. It applies the rate for the HS
code and returns the duty and the VAT base.
