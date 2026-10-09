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
// Simulate representative key-service failures at the external boundary.
function failJwksWith(failure: "http" | "schema"): void {
  jwksFetch.mockImplementation(async () =>
    failure === "http"
      ? new Response("Unavailable", { status: 503 })
      : Response.json({ keys: null }),
  );
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
    new Request("http://localhost/app/api/tokens", {
      headers: token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token },
    }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

// Generate independent RSA material for authentication and key rotation cases.
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
    ["unsupported algorithm", { alg: "HS256", kid: "primary" }],
    ["missing key ID", { alg: "RS256" }],
  ])("rejects an invalid header: %s", async (_name, header) => {
    expect((await request(await assertion({}, header))).status).toBe(401);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["empty subject", { sub: "" }],
    ["string expiry", { exp: String(NOW + 60) }],
    ["mixed audience array", { aud: ["test-access-audience", 1] }],
  ])("rejects a representative invalid claim: %s", async (_name, claims) => {
    expect((await request(await assertion(claims))).status).toBe(401);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("rejects expiry exactly at the current time", async () => {
    expect((await request(await assertion({ exp: NOW }))).status).toBe(401);
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("accepts an assertion one second before expiry without a future-iat restriction", async () => {
    expect(
      (await request(await assertion({ exp: NOW + 1, iat: NOW + 1 }))).status,
    ).toBe(200);
  });

  it.each(["one.two", "@@.e30.AA"])(
    "controls representative malformed JWT rejection: %s",
    async (token) => {
      const response = await request(token);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    },
  );

  it("rejects malformed signature encoding", async () => {
    const token = await assertion();
    const response = await request(
      `${token.split(".").slice(0, 2).join(".")}.@`,
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("fails closed when an RSA key cannot be imported", async () => {
    jwksFetch.mockResolvedValue(
      Response.json({
        keys: [{ kid: "primary", kty: "RSA", n: "invalid", e: "" }],
      }),
    );
    const response = await request(await assertion());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
  });

  it("uses fresh rotated keys and rejects retired keys", async () => {
    const originalToken = await assertion({ exp: NOW + 7200 });
    expect((await request(originalToken)).status).toBe(200);
    const rotated = await generateRsaKey();
    const rotatedJwk = await publicJwk(rotated);
    jwksFetch.mockImplementation(async () =>
      Response.json({ keys: [{ ...rotatedJwk, kid: "rotated" }] }),
    );
    vi.spyOn(Date, "now").mockReturnValue((NOW + 1) * 1000);
    expect((await request(originalToken)).status).toBe(200);
    expect(jwksFetch).toHaveBeenCalledTimes(1);

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
    expect(jwksFetch).toHaveBeenCalledTimes(3);
    const persisted = await getDb(env.DB).select().from(users).all();
    expect(persisted.map((user) => user.id).sort()).toEqual([
      "access-user",
      "rotated-user",
    ]);
  });

  it("rejects a missing assertion without contacting JWKS or provisioning", async () => {
    expect((env as unknown as Record<string, string>).DEV_MODE).toBe("false");
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("reports unavailable authentication without an Access audience", async () => {
    const bindings: Env = { ...env, CF_ACCESS_ISSUER: ISSUER };
    // Deliberately violate the generated binding contract to test deployment misconfiguration.
    Reflect.deleteProperty(bindings, "CF_ACCESS_AUD");
    const response = await request(await assertion(), bindings);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Authentication unavailable");
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("reports unavailable authentication for an invalid issuer", async () => {
    const response = await request(await assertion(), {
      ...env,
      CF_ACCESS_ISSUER: `${ISSUER}/path`,
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Authentication unavailable");
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(0);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

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

  it.each(["http", "schema"] as const)(
    "fails closed on a representative JWKS %s failure",
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
      { redirect: "manual" },
    );
    expect(await getDb(env.DB).select().from(users).all()).toHaveLength(1);
  });

  it("does not fall back to expired keys after a refresh failure", async () => {
    expect((await request(await assertion({ exp: NOW + 7200 }))).status).toBe(
      200,
    );
    vi.spyOn(Date, "now").mockReturnValue((NOW + 3600) * 1000);
    failJwksWith("http");
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
  });

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
      redirect: "manual",
    });
  });
});
