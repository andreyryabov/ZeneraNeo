# Segment ports

A segment port is a VM's attachment to a segment, at
`/infra/segments/<segment-id>/ports/<port-id>`. Port ids for VM attachments have the form
`default:<uuid>`; the attachment's `id` is the VIF's UUID and `type` is `PARENT`.

- `parent_path` is the segment's policy path, e.g. `/infra/segments/seg-web-prod`.
- `address_bindings[]` hold the VM's IP and MAC (`00:50:56:…` for VMware NICs).
- `admin_state` is inherited from the segment unless set on the port.

Listing a segment's ports returns only the ports of that segment.
