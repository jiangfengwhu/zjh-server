#!/bin/bash
set -euo pipefail
umask 077
backup_dir=/var/backups/shenghua
install -d -m 0700 "$backup_dir"
exec 9>/run/shenghua-backup.lock
flock -n 9 || exit 0
backup_path="$backup_dir/$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f -- "$backup_path.pending"' EXIT
docker exec shenghua-postgres pg_dump -U postgres -d shenghua --format=custom --compress=5 --no-owner --no-acl > "$backup_path.pending"
docker exec -i shenghua-postgres pg_restore --list < "$backup_path.pending" > /dev/null
mv -- "$backup_path.pending" "$backup_path"
# Keep at least seven verified snapshots. Never delete outside this directory.
find "$backup_dir" -maxdepth 1 -type f -name '*.dump' -printf '%f\n' | sort -r | tail -n +8 | while IFS= read -r name; do
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z\.dump$ ]] && rm -f -- "$backup_dir/$name"
done
