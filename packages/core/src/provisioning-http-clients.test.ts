/**
 * Tests for HttpGiteaProvisioningClient and HttpMinioProvisioningClient.
 *
 * Both clients are tested in isolation by mocking their HTTP layers:
 *   - Gitea: vi.spyOn(global, 'fetch') — intercepts native fetch calls
 *   - MinIO: vi.mock('@aws-sdk/client-s3') — intercepts S3Client.send()
 */

import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpGiteaProvisioningClient,
  HttpMinioProvisioningClient,
} from "./provisioning-http-clients.js";

// ---------------------------------------------------------------------------
// Gitea test helpers
// ---------------------------------------------------------------------------

const GITEA_CONFIG = {
  baseUrl: "http://gitea.test",
  token: "test-token",
  owner: "growthos",
  templateOwner: "growthos",
};

const makeGiteaClient = () => new HttpGiteaProvisioningClient(GITEA_CONFIG);

const mockFetch = (responses: Array<{ status: number; body: unknown }>) => {
  const spy = vi.spyOn(global, "fetch");
  let callIndex = 0;
  spy.mockImplementation(() => {
    const response = responses[callIndex++] ?? {
      status: 500,
      body: "unexpected call",
    };
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body)),
    } as Response);
  });
  return spy;
};

// ---------------------------------------------------------------------------
// HttpGiteaProvisioningClient — provisionWorkspaceRepo
// ---------------------------------------------------------------------------

describe("HttpGiteaProvisioningClient.provisionWorkspaceRepo", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates repo from template and returns isNew=true when repo does not exist", async () => {
    mockFetch([
      { status: 404, body: {} }, // GET /repos/{owner}/{repo} → not found
      {
        status: 201,
        body: { html_url: "http://gitea.test/growthos/workspace-abc" },
      }, // POST /generate
    ]);

    const client = makeGiteaClient();
    const result = await client.provisionWorkspaceRepo({
      tenantId: "tenant-abc",
      templateRepo: "growthos-ws-template",
      repoName: "workspace-abc",
    });

    expect(result.isNew).toBe(true);
    expect(result.repoUrl).toBe("http://gitea.test/growthos/workspace-abc");
  });

  it("returns isNew=false when repo already exists", async () => {
    mockFetch([
      {
        status: 200,
        body: { html_url: "http://gitea.test/growthos/workspace-abc" },
      }, // GET → exists
    ]);

    const client = makeGiteaClient();
    const result = await client.provisionWorkspaceRepo({
      tenantId: "tenant-abc",
      templateRepo: "growthos-ws-template",
      repoName: "workspace-abc",
    });

    expect(result.isNew).toBe(false);
    expect(result.repoUrl).toBe("http://gitea.test/growthos/workspace-abc");
  });

  it("handles 409 from generate endpoint idempotently (race condition)", async () => {
    mockFetch([
      { status: 404, body: {} }, // GET → not found
      { status: 409, body: { message: "repo already exists" } }, // POST → 409 race
      {
        status: 200,
        body: { html_url: "http://gitea.test/growthos/workspace-abc" },
      }, // GET again
    ]);

    const client = makeGiteaClient();
    const result = await client.provisionWorkspaceRepo({
      tenantId: "tenant-abc",
      templateRepo: "growthos-ws-template",
      repoName: "workspace-abc",
    });

    expect(result.isNew).toBe(false);
    expect(result.repoUrl).toBe("http://gitea.test/growthos/workspace-abc");
  });

  it("throws GiteaApiError on unexpected server error", async () => {
    mockFetch([
      { status: 404, body: {} },
      { status: 500, body: { message: "internal server error" } },
    ]);

    const client = makeGiteaClient();
    await expect(
      client.provisionWorkspaceRepo({
        tenantId: "tenant-abc",
        templateRepo: "growthos-ws-template",
        repoName: "workspace-abc",
      }),
    ).rejects.toThrow("Gitea API error 500");
  });
});

// ---------------------------------------------------------------------------
// HttpGiteaProvisioningClient — createOrUpdateFile
// ---------------------------------------------------------------------------

describe("HttpGiteaProvisioningClient.createOrUpdateFile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates file when it does not exist and returns isNew=true", async () => {
    mockFetch([
      { status: 404, body: {} }, // GET /contents → not found
      { status: 201, body: { content: { sha: "abc123" } } }, // POST create
    ]);

    const client = makeGiteaClient();
    const result = await client.createOrUpdateFile({
      tenantId: "tenant-abc",
      repoName: "workspace-abc",
      filePath: "docs/FOUNDER.md",
      content: "# Hello",
      commitMessage: "chore: seed FOUNDER.md",
    });

    expect(result.isNew).toBe(true);
    expect(result.sha).toBe("abc123");
  });

  it("updates file when it already exists and returns isNew=false", async () => {
    mockFetch([
      { status: 200, body: { sha: "existingsha" } }, // GET → exists
      { status: 200, body: { content: { sha: "newsha456" } } }, // PUT update
    ]);

    const client = makeGiteaClient();
    const result = await client.createOrUpdateFile({
      tenantId: "tenant-abc",
      repoName: "workspace-abc",
      filePath: "docs/FOUNDER.md",
      content: "# Updated",
      commitMessage: "chore: update FOUNDER.md",
    });

    expect(result.isNew).toBe(false);
    expect(result.sha).toBe("newsha456");
  });

  it("throws GiteaApiError on PUT failure", async () => {
    mockFetch([
      { status: 200, body: { sha: "existingsha" } },
      { status: 422, body: { message: "unprocessable entity" } },
    ]);

    const client = makeGiteaClient();
    await expect(
      client.createOrUpdateFile({
        tenantId: "tenant-abc",
        repoName: "workspace-abc",
        filePath: "docs/FOUNDER.md",
        content: "# Bad update",
        commitMessage: "bad",
      }),
    ).rejects.toThrow("Gitea API error 422");
  });
});

// ---------------------------------------------------------------------------
// HttpMinioProvisioningClient
// ---------------------------------------------------------------------------

describe("HttpMinioProvisioningClient.provisionBucket", () => {
  beforeEach(() => {
    vi.spyOn(S3Client.prototype, "send");
  });
  afterEach(() => vi.restoreAllMocks());

  const makeMinioClient = () =>
    new HttpMinioProvisioningClient({
      endpoint: "http://localhost:9088",
      region: "us-east-1",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });

  it("creates bucket and returns isNew=true when bucket does not exist", async () => {
    const sendSpy = vi
      .spyOn(S3Client.prototype, "send")
      .mockRejectedValueOnce(
        Object.assign(new Error("NoSuchBucket"), {
          name: "NoSuchBucket",
          $metadata: { httpStatusCode: 404 },
        }),
      )
      .mockResolvedValueOnce({} as never);

    const client = makeMinioClient();
    const result = await client.provisionBucket({
      bucketName: "growthos-tenant-abc",
      tenantId: "tenant-abc",
    });

    expect(result.isNew).toBe(true);
    expect(result.bucketName).toBe("growthos-tenant-abc");
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("returns isNew=false when bucket already exists", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({} as never);

    const client = makeMinioClient();
    const result = await client.provisionBucket({
      bucketName: "growthos-tenant-abc",
      tenantId: "tenant-abc",
    });

    expect(result.isNew).toBe(false);
    expect(result.bucketName).toBe("growthos-tenant-abc");
  });

  it("re-throws unexpected S3 errors (e.g. permissions)", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(
      Object.assign(new Error("AccessDenied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );

    const client = makeMinioClient();
    await expect(
      client.provisionBucket({
        bucketName: "growthos-tenant-abc",
        tenantId: "tenant-abc",
      }),
    ).rejects.toThrow("AccessDenied");
  });

  it("treats httpStatusCode 404 response as non-existing bucket", async () => {
    vi.spyOn(S3Client.prototype, "send")
      .mockRejectedValueOnce(
        Object.assign(new Error("Not Found"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        }),
      )
      .mockResolvedValueOnce({} as never);

    const client = makeMinioClient();
    const result = await client.provisionBucket({
      bucketName: "growthos-tenant-new",
      tenantId: "tenant-new",
    });
    expect(result.isNew).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fromEnv factory methods
// ---------------------------------------------------------------------------

describe("HttpGiteaProvisioningClient.fromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws when GITEA_BASE_URL is not set", () => {
    vi.stubEnv("GITEA_BASE_URL", "");
    vi.stubEnv("GITEA_TOKEN", "token");
    expect(() => HttpGiteaProvisioningClient.fromEnv()).toThrow(
      "GITEA_BASE_URL",
    );
  });

  it("throws when GITEA_TOKEN is not set", () => {
    vi.stubEnv("GITEA_BASE_URL", "http://gitea.test");
    vi.stubEnv("GITEA_TOKEN", "");
    expect(() => HttpGiteaProvisioningClient.fromEnv()).toThrow("GITEA_TOKEN");
  });

  it("returns a client when all required env vars are set", () => {
    vi.stubEnv("GITEA_BASE_URL", "http://gitea.test");
    vi.stubEnv("GITEA_TOKEN", "test-token");
    expect(() => HttpGiteaProvisioningClient.fromEnv()).not.toThrow();
  });
});

describe("HttpMinioProvisioningClient.fromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws when MINIO_ENDPOINT is not set", () => {
    vi.stubEnv("MINIO_ENDPOINT", "");
    vi.stubEnv("MINIO_ACCESS_KEY", "key");
    vi.stubEnv("MINIO_SECRET_KEY", "secret");
    expect(() => HttpMinioProvisioningClient.fromEnv()).toThrow(
      "MINIO_ENDPOINT",
    );
  });

  it("returns a client when all required env vars are set", () => {
    vi.stubEnv("MINIO_ENDPOINT", "http://localhost:9088");
    vi.stubEnv("MINIO_ACCESS_KEY", "minioadmin");
    vi.stubEnv("MINIO_SECRET_KEY", "minioadmin");
    expect(() => HttpMinioProvisioningClient.fromEnv()).not.toThrow();
  });
});
