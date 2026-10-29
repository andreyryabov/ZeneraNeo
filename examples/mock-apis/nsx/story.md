# Datacenter prod-dc1 — the morning after the cutover

The NSX deployment manages **prod-dc1**, the production datacenter of Kestrel Bank. It was
migrated to the NSX Policy API last weekend; this morning the network team is checking the
result. The API is called by **Ines Albrecht** (`ines.albrecht@kestrel-bank.example`), the
network lead.

## Topology

- One Tier-0 gateway, **`t0-core-01`**, uplinks to the two core routers over BGP
  (local AS 65001; neighbours 10.0.1.1 and 10.0.1.2).
- Three Tier-1 gateways hang off it: **`t1-web`**, **`t1-app`** and **`t1-db`**.
- Overlay segments use the transport zone **`tz-overlay`**; the two VLAN segments for the
  edge uplinks use **`tz-vlan-edge`**.

## Segments

| Segment           | Tier-1   | Subnet (gateway) | Notes                                            |
| ----------------- | -------- | ---------------- | ------------------------------------------------ |
| `seg-web-prod`    | `t1-web` | 10.10.10.1/24    | 6 web VMs                                        |
| `seg-app-prod`    | `t1-app` | 10.10.20.1/24    | 8 app VMs                                        |
| `seg-db-prod`     | `t1-db`  | 10.10.30.1/24    | 3 database VMs; **admin state DOWN** — see below |
| `seg-mgmt`        | `t1-app` | 10.10.99.1/24    | jump hosts                                       |
| `uplink-vlan-101` | —        | VLAN 101         | edge uplink A, `tz-vlan-edge`                    |
| `uplink-vlan-102` | —        | VLAN 102         | edge uplink B, `tz-vlan-edge`                    |

## What is wrong

`seg-db-prod` was left **administratively down** after the cutover: its ports exist but
pass no traffic, so the app tier cannot reach the databases. Nobody has noticed yet that
this is the cause; the app team reports "database timeouts since 07:40".
