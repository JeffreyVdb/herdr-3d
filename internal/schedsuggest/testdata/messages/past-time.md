The maintenance window for the database upgrade was at 09:00 UTC today, and I ran the upgrade then: Postgres is on 17.4 and all checks passed.

The only thing that had to wait was the vacuum, which I ran right after the window at 09:00 UTC as planned. Nothing else is pending.
