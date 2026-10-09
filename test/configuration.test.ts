import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import * as workerExports from "../src/index";

// Keep assertions limited to configuration that controls dispatch or required capabilities.
const configuration = v.parse(
  v.object({
    main: v.string(),
    triggers: v.object({ crons: v.array(v.string()) }),
    workflows: v.array(
      v.object({ binding: v.string(), class_name: v.string() }),
    ),
    d1_databases: v.array(v.object({ binding: v.string() })),
    analytics_engine_datasets: v.array(v.object({ binding: v.string() })),
    ratelimits: v.array(
      v.object({
        name: v.string(),
        namespace_id: v.string(),
        simple: v.object({ limit: v.number(), period: v.number() }),
      }),
    ),
    secrets: v.object({ required: v.array(v.string()) }),
  }),
  JSON.parse((env as unknown as Record<string, string>).TEST_WRANGLER_CONFIG),
);

describe("consequential Worker configuration", () => {
  it("configures exactly the schedules exercised by scheduled dispatch tests", () => {
    expect(configuration.triggers.crons.toSorted()).toEqual([
      "*/30 * * * *",
      "0 3 * * 1",
    ]);
  });

  it("registers the Polling binding with an exported Workflow class", () => {
    const registrations = configuration.workflows.filter(
      (workflow) => workflow.binding === "FEED_POLLING_WORKFLOW",
    );
    expect(configuration.main).toBe("./src/index.tsx");
    expect(registrations).toEqual([
      { binding: "FEED_POLLING_WORKFLOW", class_name: "FeedPollingWorkflow" },
    ]);
    expect(Reflect.get(workerExports, registrations[0].class_name)).toBeTypeOf(
      "function",
    );
    expect(env.FEED_POLLING_WORKFLOW.create).toBeTypeOf("function");
  });

  it("declares required storage, analytics, login, and Access bindings", () => {
    expect(
      configuration.d1_databases.map((database) => database.binding),
    ).toContain("DB");
    expect(
      configuration.analytics_engine_datasets.map((dataset) => dataset.binding),
    ).toContain("ANALYTICS");
    expect(
      configuration.ratelimits.filter(
        (limiter) => limiter.name === "LOGIN_RATE_LIMITER",
      ),
    ).toEqual([
      {
        name: "LOGIN_RATE_LIMITER",
        namespace_id: expect.stringMatching(/^\d+$/),
        simple: { limit: 5, period: 60 },
      },
    ]);
    expect(configuration.secrets.required).toEqual(
      expect.arrayContaining(["CF_ACCESS_AUD", "CF_ACCESS_ISSUER"]),
    );
    expect(env.DB.prepare).toBeTypeOf("function");
    expect(env.ANALYTICS.writeDataPoint).toBeTypeOf("function");
    expect(env.LOGIN_RATE_LIMITER.limit).toBeTypeOf("function");
  });
});
