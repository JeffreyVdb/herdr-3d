I kicked off the full reindex of the `orders` search index on staging (`make reindex ENV=staging INDEX=orders`). It is running now and the job log says it takes about two hours.

In 2 hours, once it has finished, the alias `orders_current` has to be swapped to the new index `orders_v7` and the old `orders_v6` dropped. Don't swap it before the job reports `reindex complete`: the alias would point at a half-filled index.
