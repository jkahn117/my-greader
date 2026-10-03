# Keep D1 authoritative and Analytics Engine optional

D1 is authoritative for polling outcomes, Feed health, Items, and dashboard history; Workers Analytics Engine supplies optional aggregate trends. Analytics delivery or query failures must not affect durable application behavior, and the dashboard's core activity remains available without Analytics Engine credentials.
