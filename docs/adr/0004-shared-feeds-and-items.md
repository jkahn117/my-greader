# Share canonical Feeds and Items across Users

A Feed URL has one canonical Feed record and one shared copy of each Item, while Subscriptions and Item State are per-User. This avoids fetching and storing duplicate content for every subscriber, at the cost of carefully scoping reading state and visibility to each User's Subscriptions.
