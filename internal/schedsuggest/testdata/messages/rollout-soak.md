## Vector 0.59 rollout: summary

PR #412 on `infra/ansible` is merged and the play ran against all 14 log shippers.

**Done**
- Bumped `vector_version` to `0.59.1` in `group_vars/shippers.yml` and pinned the new `vector.toml.j2` (the `remap` transform now uses `parse_json!`).
- Rolled out in three waves (2 canaries, 6, 6). Every host reports `vector --version` 0.59.1 and `systemctl is-active vector` is active.
- Backed up the old configs to `/var/backups/vector-0.58/` on each host and snapshotted the Loki ingest dashboard (link in the PR).
- Error rate on the `vector_component_errors_total` panel is flat; ingest lag p99 is 1.8 s, same as before.

**Remaining**
- 24h soak, until about 10:45 UTC tomorrow. Nothing to do while it runs; the alert rule `VectorIngestLag` pages if p99 lag goes above 10 s.
- After the soak: check the dashboard and `journalctl -u vector --since "24 hours ago" | grep -c ERROR` on two hosts, delete the `/var/backups/vector-0.58/` backups on all 14 hosts (`ansible shippers -m file -a "path=/var/backups/vector-0.58 state=absent" -b`), attach the dashboard screenshot as evidence to OPS-2291 and close it.
