import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db";
import { users } from "../src/db/schema";

const ISSUER = "https://test-team.cloudflareaccess.com";
const NOW = 1_800_000_000;
let worker: typeof import("../src/index").default;
let key: CryptoKeyPair;
let jwk: JsonWebKey;
let jwksFetch: ReturnType<typeof vi.fn>;
const JWKS_FAILURES = ["http", "network", "json", "schema"] as const;

// Simulate key-service failures at the only replaced external boundary.
function failJwksWith(failure: (typeof JWKS_FAILURES)[number]): void {
  jwksFetch.mockImplementation(async () => {
    if (failure === "network") throw new Error("Network unavailable");
    if (failure === "http") return new Response("Unavailable", { status: 503 });
    if (failure === "json") return new Response("not json");
    return Response.json({ keys: null });
  });
}

// Encode the actual UTF-8 signing input, including non-ASCII identity claims.
function encode(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

// Use unpadded base64url as required by compact JWT serialization.
function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Sign locally with real Web Crypto; only the external key service is replaced.
async function assertion(
  claims: Record<string, unknown> = {},
  header: unknown = { alg: "RS256", kid: "primary" },
  signingKey = key.privateKey,
): Promise<string> {
  const input = `${encode(header)}.${encode({ iss: ISSUER, sub: "access-user", email: "josé@example.com", aud: "test-access-audience", iat: NOW - 60, exp: NOW + 60, ...claims })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

// Execute the protected Worker HTTP route with real migrated D1 and production bindings.
async function request(
  token?: string,
  bindings: Env = { ...env, CF_ACCESS_ISSUER: ISSUER },
): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request("http://localhost/app/access", {
      headers: token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token },
    }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

// Generate independent RSA material for authentication, wrong-signature, and rotation cases.
async function generateRsaKey(): Promise<CryptoKeyPair> {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) throw new Error("Expected an RSA key pair");
  return generated;
}

// Export only the public key used by the simulated JWKS service.
async function publicJwk(pair: CryptoKeyPair): Promise<JsonWebKey> {
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported instanceof ArrayBuffer) throw new Error("Expected a JWK");
  return exported;
}

beforeEach(async () => {
  vi.resetModules();
  worker = (await import("../src/index")).default;
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM users");
  key = await generateRsaKey();
  jwk = await publicJwk(key);
  jwksFetch = vi.fn(async () =>
    Response.json({ keys: [{ ...jwk, kid: "primary" }] }),
  );
  vi.stubGlobal("fetch", jwksFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("production Access through protected Worker requests", () => {
  it("rejects an unexpected issuer without contacting its key service", async () => {
    expect(
      (await request(await assertion({ iss: "https://attacker.example" })))
        .status,
    ).toBe(401);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["HS256", { alg: "HS256", kid: "primary" }],
    ["none", { alg: "none", kid: "primary" }],
    ["missing algorithm", { kid: "primary" }],
    ["missing kid", { alg: "RS256" }],
    ["empty kid", { alg: "RS256", kid: "" }],
    ["numeric kid", { alg: "RS256", kid: 1 }],
  ])(
    "rejects unsupported header %s before fetching keys",
    async (_name, header) => {
      expect((await request(await assertion({}, header))).status).toBe(401);
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
      expect(jwksFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["empty subject", { sub: "" }],
    ["numeric subject", { sub: 123 }],
    ["missing subject", { sub: undefined }],
    ["null email", { email: null }],
    ["blank email", { email: "  " }],
    ["missing email", { email: undefined }],
    ["missing expiry", { exp: undefined }],
    ["string expiry", { exp: String(NOW + 60) }],
    ["fractional expiry", { exp: NOW + 0.5 }],
    ["null expiry", { exp: null }],
    ["missing issued-at", { iat: undefined }],
    ["string issued-at", { iat: String(NOW) }],
    ["fractional issued-at", { iat: NOW - 0.5 }],
    ["mixed audience array", { aud: ["test-access-audience", 1] }],
    ["empty audience", { aud: [] }],
    ["numeric audience", { aud: 1 }],
    ["missing issuer", { iss: undefined }],
    ["null issuer", { iss: null }],
  ])("rejects invalid claim shape: %s", async (_name, claims) => {
    expect((await request(await assertion(claims))).status).toBe(401);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it.each([NOW - 1, NOW])(
    "rejects expiry at or before now: %s",
    async (exp) => {
      expect((await request(await assertion({ exp }))).status).toBe(401);
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
      expect(jwksFetch).not.toHaveBeenCalled();
    },
  );

  it("accepts an assertion one second before expiry without a future-iat restriction", async () => {
    expect(
      (await request(await assertion({ exp: NOW + 1, iat: NOW + 1 }))).status,
    ).toBe(200);
  });

  it.each([
    "one",
    "one.two",
    "a.b.c.d",
    "@@.e30.AA",
    `${encode(null)}.${encode({})}.AA`,
    `${encode({ alg: "RS256", kid: "primary" })}.${encode(null)}.AA`,
    `${encode({})}.${bytesToBase64Url(new TextEncoder().encode("not json"))}.AA`,
  ])("controls malformed JWT rejection: %s", async (token) => {
    const response = await request(token);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
  });

  it.each(["@", "A", "", "AA==", "AA+/"])(
    "controls invalid signature encoding: %s",
    async (signature) => {
      const token = await assertion();
      const response = await request(
        `${token.split(".").slice(0, 2).join(".")}.${signature}`,
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    },
  );

  it.each([
    null,
    {},
    { keys: null },
    { keys: {} },
    { keys: [null] },
    { keys: [{ kid: "primary", kty: "RSA", n: "invalid", e: "" }] },
    { keys: [{ kid: "primary", kty: "RSA", n: "@", e: "AQAB" }] },
  ])("fails closed for invalid JWKS: %j", async (body) => {
    jwksFetch.mockResolvedValue(Response.json(body));
    const response = await request(await assertion());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
  });

  it.each([
    { age: 1, cachedKeyStatus: 200, fetchesBeforeRotation: 1 },
    { age: 3600, cachedKeyStatus: 401, fetchesBeforeRotation: 2 },
  ])(
    "uses rotated keys and rejects retired keys at cache age $age seconds",
    async ({ age, cachedKeyStatus, fetchesBeforeRotation }) => {
      const originalToken = await assertion({ exp: NOW + 7200 });
      expect((await request(originalToken)).status).toBe(200);
      const rotated = await generateRsaKey();
      const rotatedJwk = await publicJwk(rotated);
      jwksFetch.mockImplementation(async () =>
        Response.json({ keys: [{ ...rotatedJwk, kid: "rotated" }] }),
      );
      vi.spyOn(Date, "now").mockReturnValue((NOW + age) * 1000);
      // Fresh keys remain trusted until refresh; expired keys cannot hide retirement.
      expect((await request(originalToken)).status).toBe(cachedKeyStatus);
      expect(jwksFetch).toHaveBeenCalledTimes(fetchesBeforeRotation);
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(1);
      const rotatedToken = await assertion(
        { sub: "rotated-user", email: "rotated@example.com", exp: NOW + 7200 },
        { alg: "RS256", kid: "rotated" },
        rotated.privateKey,
      );
      expect((await request(rotatedToken)).status).toBe(200);
      expect(jwksFetch).toHaveBeenCalledTimes(2);
      expect((await request(rotatedToken)).status).toBe(200);
      expect(jwksFetch).toHaveBeenCalledTimes(2);

      const retiredToken = await assertion({
        sub: "retired-user",
        email: "retired@example.com",
        exp: NOW + 7200,
      });
      const rejected = await request(retiredToken);
      expect(rejected.status).toBe(401);
      expect(await rejected.text()).toBe("Unauthorized");
      // The retired kid gets one refresh, but the new key set never accepts it.
      expect(jwksFetch).toHaveBeenCalledTimes(3);
      expect((await request(rotatedToken)).status).toBe(200);
      expect(jwksFetch).toHaveBeenCalledTimes(3);
      const persisted = await getDb(env.DB).select().from(users).all();
      expect(persisted.map((user) => user.id).sort()).toEqual([
        "access-user",
        "rotated-user",
      ]);
    },
  );

  it("rejects a missing assertion without contacting JWKS or provisioning", async () => {
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it.each(["CF_ACCESS_AUD", "CF_ACCESS_ISSUER"])(
    "reports unavailable authentication for missing required secret %s",
    async (secret) => {
      const bindings: Env = { ...env, CF_ACCESS_ISSUER: ISSUER };
      // Deliberately violate the generated binding contract to test deployment misconfiguration.
      Reflect.deleteProperty(bindings, secret);
      const response = await request(await assertion(), bindings);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Authentication unavailable");
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
      expect(jwksFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { CF_ACCESS_ISSUER: "http://test-team.cloudflareaccess.com" },
    {
      CF_ACCESS_ISSUER: "https://user:password@test-team.cloudflareaccess.com",
    },
    { CF_ACCESS_ISSUER: `${ISSUER}/path` },
  ])(
    "reports unavailable authentication for invalid configuration: %j",
    async (override) => {
      const response = await request(await assertion(), {
        ...env,
        ...override,
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Authentication unavailable");
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
      expect(jwksFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects the wrong audience", async () => {
    expect(
      (await request(await assertion({ aud: "different-application" }))).status,
    ).toBe(401);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown key from freshly fetched JWKS without repeated fetches", async () => {
    expect(
      (await request(await assertion({}, { alg: "RS256", kid: "unknown" })))
        .status,
    ).toBe(401);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
  });

  it("rejects a modified payload", async () => {
    const parts = (await assertion()).split(".");
    parts[1] = encode({
      iss: ISSUER,
      sub: "intruder",
      email: "intruder@example.com",
      aud: "test-access-audience",
      iat: NOW - 60,
      exp: NOW + 60,
    });
    expect((await request(parts.join("."))).status).toBe(401);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
  });

  it("rejects a signature made by a different RSA private key", async () => {
    const other = await generateRsaKey();
    expect(
      (await request(await assertion({}, undefined, other.privateKey))).status,
    ).toBe(401);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
  });

  it.each(JWKS_FAILURES)(
    "fails closed on JWKS %s failures",
    async (failure) => {
      failJwksWith(failure);
      const response = await request(await assertion());
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    },
  );

  it("reuses keys before TTL and refetches exactly at the one-hour expiry boundary", async () => {
    expect((await request(await assertion({ exp: NOW + 7200 }))).status).toBe(
      200,
    );
    vi.spyOn(Date, "now").mockReturnValue((NOW + 3599) * 1000);
    expect((await request(await assertion({ exp: NOW + 7200 }))).status).toBe(
      200,
    );
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue((NOW + 3600) * 1000);
    expect((await request(await assertion({ exp: NOW + 7200 }))).status).toBe(
      200,
    );
    expect(jwksFetch).toHaveBeenCalledTimes(2);
  });

  it("starts with an empty JWKS cache after resetting Worker modules", async () => {
    expect((await request(await assertion())).status).toBe(200);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    jwksFetch.mockImplementation(async () => Response.json({ keys: [] }));
    vi.resetModules();
    worker = (await import("../src/index")).default;

    const response = await request(
      await assertion({
        sub: "isolated-user",
        email: "isolated@example.com",
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(jwksFetch).toHaveBeenCalledTimes(2);
    const persisted = await getDb(env.DB).select().from(users).all();
    expect(persisted.map((user) => user.id)).toEqual(["access-user"]);
  });

  it("does not reuse keys from another configured issuer", async () => {
    expect((await request(await assertion())).status).toBe(200);
    const otherIssuer = "https://other-team.cloudflareaccess.com";
    jwksFetch.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    expect(
      (
        await request(
          await assertion({
            iss: otherIssuer,
            sub: "other-user",
            email: "other@example.com",
          }),
          { ...env, CF_ACCESS_ISSUER: otherIssuer },
        )
      ).status,
    ).toBe(401);
    expect(jwksFetch).toHaveBeenLastCalledWith(
      `${otherIssuer}/cdn-cgi/access/certs`,
      { redirect: "error" },
    );
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(1);
  });

  it.each(JWKS_FAILURES)(
    "does not fall back to expired keys after a %s failure",
    async (failure) => {
      expect((await request(await assertion({ exp: NOW + 7200 }))).status).toBe(
        200,
      );
      vi.spyOn(Date, "now").mockReturnValue((NOW + 3600) * 1000);
      failJwksWith(failure);
      expect(
        (
          await request(
            await assertion({
              sub: "new-user",
              email: "new@example.com",
              exp: NOW + 7200,
            }),
          )
        ).status,
      ).toBe(401);
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(1);
      expect(jwksFetch).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a still-unknown key after one cache refresh", async () => {
    expect((await request(await assertion())).status).toBe(200);
    expect(
      (
        await request(
          await assertion(
            { sub: "unknown-user" },
            { alg: "RS256", kid: "unknown" },
          ),
        )
      ).status,
    ).toBe(401);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(1);
  });

  it.each(JWKS_FAILURES)(
    "fails closed when an unknown-key refresh encounters a %s failure",
    async (failure) => {
      expect((await request(await assertion())).status).toBe(200);
      failJwksWith(failure);
      const response = await request(
        await assertion(
          { sub: "unknown-user", email: "unknown@example.com" },
          { alg: "RS256", kid: "unknown" },
        ),
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(jwksFetch).toHaveBeenCalledTimes(2);
      const persisted = await getDb(env.DB).select().from(users).all();
      expect(persisted.map((user) => user.id)).toEqual(["access-user"]);
    },
  );

  it("verifies RSA assertions and provisions a UTF-8 User only once", async () => {
    expect((await request(await assertion())).status).toBe(200);
    expect(
      (
        await request(
          await assertion({ aud: ["other", "test-access-audience"] }),
        )
      ).status,
    ).toBe(200);
    const persisted = await getDb(env.DB).select().from(users).all();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: "access-user",
      email: "josé@example.com",
    });
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    expect(jwksFetch).toHaveBeenCalledWith(`${ISSUER}/cdn-cgi/access/certs`, {
      redirect: "error",
    });
  });
});
