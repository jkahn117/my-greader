import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { users } from "../src/db/schema";
import { getDb } from "../src/lib/db";

// Guards the isolated binding mode used by production Access authentication tests.
describe("production authentication test environment", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM api_tokens");
    await env.DB.exec("DELETE FROM users");
  });

  it("disables the development bypass and uses only synthetic variables", () => {
    const bindings = env as unknown as Record<string, string>;

    expect(bindings.DEV_MODE).toBe("false");
    expect(bindings.CF_ACCESS_AUD).toBe("test-access-audience");
    expect(bindings.CF_API_TOKEN).toBe("test-api-token");
    expect(bindings.ANALYTICS_ENABLED).toBe("false");
  });

  it("rejects a protected request instead of provisioning the development User", async () => {
    const request = new Request("http://localhost/app/access");
    const context = createExecutionContext();
    const response = await worker.fetch(request, env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(401);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
  });
});
