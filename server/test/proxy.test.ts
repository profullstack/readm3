import { expect, test } from "bun:test";
import { createApiProxy, clientAddress } from "../proxy.ts";

test("the frontend forwards authentication, API errors and cookies without forwarding untrusted proxy headers", async () => {
  const backend = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/v1/actions");
      expect(url.searchParams.get("test")).toBe("1");
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      expect(request.headers.get("cookie")).toBe("readm3_session=old");
      expect(request.headers.get("origin")).toBe("https://readm3.com");
      expect(request.headers.get("x-readm3-proxy-secret")).toBe(
        "trusted-secret",
      );
      expect(clientAddress(request, "proxy-address", "trusted-secret")).toBe(
        "client-address",
      );
      expect(await request.json()).toEqual({ operation: "test" });
      return Response.json(
        { error: "Conflict" },
        {
          status: 409,
          headers: {
            "set-cookie":
              "readm3_session=new; HttpOnly; Secure; SameSite=Lax; Path=/",
            "cache-control": "public",
          },
        },
      );
    },
  });
  try {
    const proxy = createApiProxy(
      `http://localhost:${backend.port}`,
      "trusted-secret",
    );
    const response = (await proxy(
      new Request("https://readm3.com/api/v1/actions?test=1", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          cookie: "readm3_session=old",
          origin: "https://readm3.com",
          "content-type": "application/json",
          "x-readm3-client-ip": "forged",
          "x-readm3-proxy-secret": "forged",
        },
        body: JSON.stringify({ operation: "test" }),
      }),
      "client-address",
    ))!;
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("readm3_session=new");
    expect(await response.json()).toEqual({ error: "Conflict" });
    expect(
      await proxy(new Request("https://readm3.com/admin"), "client-address"),
    ).toBeNull();
  } finally {
    backend.stop(true);
  }
});

test("untrusted forwarded addresses are ignored and redirects never receive credentials", async () => {
  expect(
    clientAddress(
      new Request("http://localhost", {
        headers: {
          "x-readm3-client-ip": "forged",
          "x-readm3-proxy-secret": "wrong",
        },
      }),
      "edge-address",
      "trusted-secret",
    ),
  ).toBe("edge-address");
  let destinationCalls = 0;
  const destination = Bun.serve({
    port: 0,
    fetch() {
      destinationCalls++;
      return new Response("unexpected");
    },
  });
  const backend = Bun.serve({
    port: 0,
    fetch() {
      return Response.redirect(`http://localhost:${destination.port}`);
    },
  });
  try {
    const proxy = createApiProxy(
      `http://localhost:${backend.port}`,
      "trusted-secret",
    );
    expect(
      (
        await proxy(
          new Request("https://readm3.com/api/v1/me", {
            headers: { authorization: "Bearer sensitive" },
          }),
          "client",
        )
      )?.status,
    ).toBe(503);
    expect(destinationCalls).toBe(0);
    expect(() => createApiProxy("http://example.com", "secret")).toThrow();
  } finally {
    backend.stop(true);
    destination.stop(true);
  }
});
