import { Hono } from "hono";
import { auth } from "./auth";
import { subs } from "./subscriptions";
import { stream } from "./stream";
import { state } from "./state";
import type { Variables } from "./helpers";

const greader = new Hono<{ Bindings: Env; Variables: Variables }>();

// User info — lightweight, lives here rather than its own file
greader.get("/reader/api/0/user-info", (c) => {
  const userId = c.get("userId");
  const email = c.get("email");
  return c.json({ userId, userName: email, userProfileId: userId, userEmail: email });
});

greader.route("/", auth);
greader.route("/", subs);
greader.route("/", stream);
greader.route("/", state);

export { greader };
