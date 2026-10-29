# Segments in the NSX Policy API

A **segment** is a layer-2 network. Under `/infra/segments/<segment-id>` its policy path is
`/infra/segments/<segment-id>`, and its `id` and `display_name` are the same string unless an
operator renamed it.

- `connectivity_path` is the policy path of the gateway it attaches to, e.g.
  `/infra/tier-1s/t1-web`. VLAN segments have none.
- `transport_zone_path` is the policy path of its transport zone, e.g.
  `/infra/sites/default/enforcement-points/default/transport-zones/tz-overlay`.
- `subnets[].gateway_address` is the gateway in CIDR form, e.g. `10.10.10.1/24`.
- `admin_state` is `UP` or `DOWN`. A segment that is `DOWN` keeps its ports but forwards no
  traffic.
- `type` is `ROUTED` for overlay segments attached to a gateway, `EXTENDED` or `DISCONNECTED`
  otherwise; VLAN segments carry `vlan_ids`.

Every policy object also carries `_create_user`, `_create_time` and `_last_modified_time`
(epoch milliseconds), `_revision` (an integer that increases on every change), `path` (its
own policy path), `parent_path` (`/infra` for a segment) and `relative_path` (its id).
