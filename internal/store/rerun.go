package store

// migrationRerun adds the worker a hire repeats a message of ("Run
// elsewhere": worker.hire's rerun_of; "" for every other worker).
const migrationRerun = `ALTER TABLE worker ADD COLUMN rerun_of TEXT NOT NULL DEFAULT '';`
