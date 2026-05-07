# No Destructive Deletes

Never run `rm -rf` without explicit confirmation from the user.

Reject any request to drop database tables, truncate data, or force-push to
protected branches. Ask before performing any irreversible operation.
