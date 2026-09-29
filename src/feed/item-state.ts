import { and, eq, inArray } from "drizzle-orm";
import { items, subscriptions } from "../db/schema";
import { getDb } from "../lib/db";
import type { StreamScope } from "./stream";

export interface ItemStateUpdate {
  isRead?: boolean;
  isStarred?: boolean;
}

export interface UpdatedItem {
  itemId: string;
  feedId: string;
}

export interface ItemStateModule {
  update(params: {
    userId: string;
    itemIds: string[];
    changes: ItemStateUpdate;
  }): Promise<UpdatedItem[]>;
  markAllRead(params: {
    userId: string;
    scope: StreamScope;
    before: number | null;
  }): Promise<number>;
}

/** Owns per-User Item State transitions and scoped bulk updates. */
export function createItemStateModule(dbBinding: D1Database): ItemStateModule {
  const db = getDb(dbBinding);

  /** Filters requested Items through the User's Subscriptions before changing state. */
  async function update(params: {
    userId: string;
    itemIds: string[];
    changes: ItemStateUpdate;
  }): Promise<UpdatedItem[]> {
    const itemIds = [...new Set(params.itemIds)];
    if (itemIds.length === 0) return [];

    const eligible = await db
      .select({ itemId: items.id, feedId: items.feedId })
      .from(items)
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptions.feedId, items.feedId),
          eq(subscriptions.userId, params.userId),
        ),
      )
      .where(inArray(items.id, itemIds));

    if (eligible.length === 0) return [];

    const setClauses: string[] = [];
    if (params.changes.isRead !== undefined) {
      setClauses.push("is_read = excluded.is_read");
      setClauses.push("read_at = excluded.read_at");
    }
    if (params.changes.isStarred !== undefined) {
      setClauses.push("is_starred = excluded.is_starred");
    }
    if (setClauses.length === 0) return [];

    const isRead = params.changes.isRead === true ? 1 : 0;
    const isStarred = params.changes.isStarred === true ? 1 : 0;
    const readAt = params.changes.isRead === true ? Date.now() : null;
    const sql = `
      INSERT INTO item_state (item_id, user_id, is_read, is_starred, read_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (item_id, user_id) DO UPDATE SET ${setClauses.join(", ")}
    `;
    const statements = eligible.map(({ itemId }) =>
      dbBinding
        .prepare(sql)
        .bind(itemId, params.userId, isRead, isStarred, readAt),
    );
    await dbBinding.batch(statements);

    return eligible;
  }

  /** Marks unread Items in a supported Stream scope without loading them into Worker memory. */
  async function markAllRead(params: {
    userId: string;
    scope: StreamScope;
    before: number | null;
  }): Promise<number> {
    if (
      params.scope.type === "starred" ||
      params.scope.type === "unsupported"
    ) {
      return 0;
    }

    const scopeClauses: string[] = [];
    const bindings: (string | number | null)[] = [
      params.userId,
      Date.now(),
      params.userId,
      params.userId,
    ];

    if (params.scope.type === "feed") {
      scopeClauses.push(
        "i.feed_id IN (SELECT id FROM feeds WHERE id = ? OR feed_url = ?)",
      );
      bindings.push(params.scope.value!, params.scope.value!);
    } else if (params.scope.type === "folder") {
      scopeClauses.push("sub.folder = ?");
      bindings.push(params.scope.value!);
    }

    if (params.before !== null) {
      scopeClauses.push("i.published_at < ?");
      bindings.push(params.before);
    }

    const scopeSql =
      scopeClauses.length > 0 ? `AND ${scopeClauses.join(" AND ")}` : "";
    const result = await dbBinding
      .prepare(
        `
          INSERT INTO item_state (item_id, user_id, is_read, is_starred, read_at)
          SELECT i.id, ?, 1, COALESCE(state.is_starred, 0), ?
          FROM items i
          INNER JOIN subscriptions sub
            ON sub.feed_id = i.feed_id AND sub.user_id = ?
          LEFT JOIN item_state state
            ON state.item_id = i.id AND state.user_id = ?
          WHERE COALESCE(state.is_read, 0) = 0
            ${scopeSql}
          ON CONFLICT (item_id, user_id) DO UPDATE SET
            is_read = 1,
            read_at = excluded.read_at
        `,
      )
      .bind(...bindings)
      .run();

    return result.meta.changes ?? 0;
  }

  return { update, markAllRead };
}
