/**
 * Real HTTP provisioning clients — Phase 1 / S1 (final mile)
 *
 * Production implementations of the provisioning interfaces defined in
 * `tenant-provisioning.ts`. Both clients are idempotent: they check whether
 * the resource already exists before attempting to create it and return a
 * consistent `isNew` flag so callers can distinguish create from skip.
 *
 * Selection strategy (in `worker-workflow-callback`):
 *   ENABLE_REAL_GITEA_CLIENT=true  → HttpGiteaProvisioningClient
 *   ENABLE_REAL_MINIO_CLIENT=true  → HttpMinioProvisioningClient
 *   (default)                      → Stub implementations (tests / local dev)
 *
 * ── Gitea ──────────────────────────────────────────────────────────────────
 * Uses the Gitea v1 REST API via native `fetch` (Node 18+).
 * Relevant endpoints:
 *   GET  /api/v1/repos/{owner}/{repo}                          — existence check
 *   POST /api/v1/repos/{template_owner}/{template}/generate    — create from template
 *   GET  /api/v1/repos/{owner}/{repo}/contents/{path}          — get file + SHA
 *   POST /api/v1/repos/{owner}/{repo}/contents/{path}          — create file
 *   PUT  /api/v1/repos/{owner}/{repo}/contents/{path}          — update file
 *
 * ── MinIO (S3-compatible) ──────────────────────────────────────────────────
 * Uses `@aws-sdk/client-s3` with MinIO's S3-compatible endpoint.
 * Relevant operations:
 *   HeadBucketCommand — existence check (200 = exists, throws NoSuchBucket = not found)
 *   CreateBucketCommand — create bucket
 */

import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import type {
  GiteaProvisioningClient,
  MinioProvisioningClient,
} from "./tenant-provisioning.js";

// ---------------------------------------------------------------------------
// Shared HTTP helpers
// ---------------------------------------------------------------------------

class GiteaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Gitea API error ${status}: ${message}`);
    this.name = "GiteaApiError";
  }
}

const toBase64 = (str: string): string =>
  Buffer.from(str, "utf8").toString("base64");

// ---------------------------------------------------------------------------
// HttpGiteaProvisioningClient
// ---------------------------------------------------------------------------

export interface GiteaClientConfig {
  /** Base URL of the Gitea instance, e.g. "http://localhost:3088" */
  baseUrl: string;
  /** Gitea API token with repo create/write permissions */
  token: string;
  /** The org/user that owns the tenant repos (e.g. "growthos") */
  owner: string;
  /** The org/user that owns the template repo */
  templateOwner: string;
}

export class HttpGiteaProvisioningClient implements GiteaProvisioningClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: GiteaClientConfig) {
    this.headers = {
      Authorization: `token ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  static fromEnv(): HttpGiteaProvisioningClient {
    const baseUrl = process.env.GITEA_BASE_URL;
    const token = process.env.GITEA_TOKEN;
    const owner = process.env.GITEA_OWNER ?? "growthos";
    const templateOwner = process.env.GITEA_TEMPLATE_OWNER ?? owner;

    if (!baseUrl) throw new Error("GITEA_BASE_URL env var is required");
    if (!token) throw new Error("GITEA_TOKEN env var is required");

    return new HttpGiteaProvisioningClient({
      baseUrl,
      token,
      owner,
      templateOwner,
    });
  }

  async provisionWorkspaceRepo(params: {
    tenantId: string;
    templateRepo: string;
    repoName: string;
  }): Promise<{ repoUrl: string; isNew: boolean }> {
    const { owner, baseUrl, templateOwner } = this.config;

    // Idempotency check: repo already exists?
    const existingUrl = await this.getRepoUrl(owner, params.repoName);
    if (existingUrl) return { repoUrl: existingUrl, isNew: false };

    // Create from template
    const resp = await fetch(
      `${baseUrl}/api/v1/repos/${templateOwner}/${params.templateRepo}/generate`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          owner,
          name: params.repoName,
          private: true,
          description: `GrowthOS workspace for tenant ${params.tenantId}`,
        }),
      },
    );

    if (!resp.ok) {
      // 409 = repo already exists (race condition); treat as idempotent success.
      if (resp.status === 409) {
        const url = await this.getRepoUrl(owner, params.repoName);
        if (url) return { repoUrl: url, isNew: false };
      }
      const body = await resp.text();
      throw new GiteaApiError(resp.status, body);
    }

    const json = (await resp.json()) as { clone_url: string; html_url: string };
    return { repoUrl: json.html_url ?? json.clone_url, isNew: true };
  }

  async createOrUpdateFile(params: {
    tenantId: string;
    repoName: string;
    filePath: string;
    content: string;
    commitMessage: string;
  }): Promise<{ sha: string; isNew: boolean }> {
    const { owner, baseUrl } = this.config;
    const encodedPath = encodeURIComponent(params.filePath).replace(
      /%2F/g,
      "/",
    );
    const url = `${baseUrl}/api/v1/repos/${owner}/${params.repoName}/contents/${encodedPath}`;

    // Check for existing file to get SHA for update.
    const existing = await this.getFileSha(
      owner,
      params.repoName,
      params.filePath,
    );

    const body: Record<string, string> = {
      message: params.commitMessage,
      content: toBase64(params.content),
    };
    if (existing) body.sha = existing;

    const resp = await fetch(url, {
      method: existing ? "PUT" : "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new GiteaApiError(resp.status, text);
    }

    const json = (await resp.json()) as {
      content?: { sha?: string };
    };
    const sha = json.content?.sha ?? "";
    return { sha, isNew: !existing };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getRepoUrl(
    owner: string,
    repoName: string,
  ): Promise<string | null> {
    const resp = await fetch(
      `${this.config.baseUrl}/api/v1/repos/${owner}/${repoName}`,
      { headers: this.headers },
    );
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const json = (await resp.json()) as { html_url?: string };
    return json.html_url ?? null;
  }

  private async getFileSha(
    owner: string,
    repoName: string,
    filePath: string,
  ): Promise<string | null> {
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, "/");
    const resp = await fetch(
      `${this.config.baseUrl}/api/v1/repos/${owner}/${repoName}/contents/${encodedPath}`,
      { headers: this.headers },
    );
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const json = (await resp.json()) as { sha?: string };
    return json.sha ?? null;
  }
}

// ---------------------------------------------------------------------------
// HttpMinioProvisioningClient
// ---------------------------------------------------------------------------

export interface MinioClientConfig {
  /**
   * MinIO endpoint URL, e.g. "http://localhost:9088"
   * Must include the scheme but no trailing slash.
   */
  endpoint: string;
  /** AWS region string; MinIO accepts any value, defaults to "us-east-1" */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class HttpMinioProvisioningClient implements MinioProvisioningClient {
  private readonly s3: S3Client;

  constructor(config: MinioClientConfig) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Required for path-style addressing with MinIO
      forcePathStyle: true,
    });
  }

  static fromEnv(): HttpMinioProvisioningClient {
    const endpoint = process.env.MINIO_ENDPOINT;
    const accessKeyId = process.env.MINIO_ACCESS_KEY;
    const secretAccessKey = process.env.MINIO_SECRET_KEY;

    if (!endpoint) throw new Error("MINIO_ENDPOINT env var is required");
    if (!accessKeyId) throw new Error("MINIO_ACCESS_KEY env var is required");
    if (!secretAccessKey)
      throw new Error("MINIO_SECRET_KEY env var is required");

    return new HttpMinioProvisioningClient({
      endpoint,
      region: process.env.MINIO_REGION ?? "us-east-1",
      accessKeyId,
      secretAccessKey,
    });
  }

  async provisionBucket(params: {
    bucketName: string;
    tenantId: string;
  }): Promise<{ bucketName: string; isNew: boolean }> {
    // Idempotency check: bucket already exists?
    const exists = await this.bucketExists(params.bucketName);
    if (exists) return { bucketName: params.bucketName, isNew: false };

    await this.s3.send(new CreateBucketCommand({ Bucket: params.bucketName }));

    return { bucketName: params.bucketName, isNew: true };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async bucketExists(bucketName: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: bucketName }));
      return true;
    } catch (err) {
      const s3err = err as S3ServiceException;
      if (s3err.$metadata?.httpStatusCode === 404) return false;
      if (s3err.name === "NoSuchBucket") return false;
      // Re-throw unexpected errors (permissions, network, etc.)
      throw err;
    }
  }
}
