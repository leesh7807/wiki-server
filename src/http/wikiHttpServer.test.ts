import assert from "node:assert/strict";
import test from "node:test";
import type { JobCommand, JobEvent, JobMetricsSummary, PublicJob } from "../jobs/jobTypes.js";
import { createWikiHttpServer } from "./wikiHttpServer.js";

test("exposes health and client routes through the HTTP boundary", async () => {
  const app = createWikiHttpServer({
    store: makeStore(),
    health: () => ({ ok: true, boundary: "http" }),
  });

  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true, boundary: "http" });

    const client = await app.inject({ method: "GET", url: "/client" });
    assert.equal(client.statusCode, 200);
    assert.match(client.headers["content-type"] ?? "", /^text\/html/);
  } finally {
    await app.close();
  }
});

test("preserves asynchronous command acceptance contract", async () => {
  const enqueued: Array<{ command: JobCommand; content: string }> = [];
  const app = createWikiHttpServer({
    store: makeStore({ enqueued }),
    health: () => ({ ok: true }),
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/query",
      payload: { content: "Where is the boundary?" },
    });

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), {
      jobId: JOB_ID,
      status: "queued",
      eventsUrl: `/jobs/${JOB_ID}/events`,
    });
    assert.deepEqual(enqueued, [
      { command: "query", content: "Where is the boundary?" },
    ]);
  } finally {
    await app.close();
  }
});

test("rejects invalid command bodies and job identifiers at the transport edge", async () => {
  const app = createWikiHttpServer({
    store: makeStore(),
    health: () => ({ ok: true }),
  });

  try {
    const invalidBody = await app.inject({
      method: "POST",
      url: "/lint",
      payload: { content: "scoped lint is not supported" },
    });
    assert.equal(invalidBody.statusCode, 400);

    const invalidId = await app.inject({ method: "GET", url: "/jobs/not-a-uuid" });
    assert.equal(invalidId.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("keeps synchronous graph search and selective reads behind the internal command boundary", async () => {
  const searches: unknown[] = [];
  const reads: unknown[] = [];
  const app = createWikiHttpServer({
    store: makeStore(),
    health: () => ({ ok: true }),
    retrieval: {
      token: "internal-secret",
      search: (input) => {
        searches.push(input);
        return { candidates: [], bodySnippetsIncluded: false };
      },
      read: (input) => {
        reads.push(input);
        return {
          path: input.path,
          title: "Selected",
          selectedBy: "line_range",
          startLine: 4,
          endLine: 8,
          totalLines: 20,
          truncated: false,
          content: "selected range",
        };
      },
    },
  });

  try {
    const hidden = await app.inject({
      method: "POST",
      url: "/_internal/retrieval/search",
      payload: { query: "alpha" },
    });
    assert.equal(hidden.statusCode, 404);

    const search = await app.inject({
      method: "POST",
      url: "/_internal/retrieval/search",
      headers: { "x-wiki-retrieval-token": "internal-secret" },
      payload: { query: "alpha", command: "ingest" },
    });
    assert.equal(search.statusCode, 200);
    assert.deepEqual(searches, [{ query: "alpha", command: "ingest" }]);

    const read = await app.inject({
      method: "POST",
      url: "/_internal/retrieval/read",
      headers: { "x-wiki-retrieval-token": "internal-secret" },
      payload: { path: "wiki/concepts/alpha.md", startLine: 4, endLine: 8 },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().content, "selected range");
    assert.deepEqual(reads, [{ path: "wiki/concepts/alpha.md", startLine: 4, endLine: 8 }]);
  } finally {
    await app.close();
  }
});

const JOB_ID = "00000000-0000-4000-8000-000000000001";

function makeStore(options: {
  enqueued?: Array<{ command: JobCommand; content: string }>;
} = {}) {
  const job: PublicJob = {
    id: JOB_ID,
    command: "query",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    contentLength: 0,
    contentPreview: "",
    metrics: { queuedAheadCount: 0 },
  };
  const metrics: JobMetricsSummary = {
    counts: {
      total: 0,
      terminal: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    },
    averages: {
      queueWaitMs: null,
      runMs: null,
      totalMs: null,
      samples: { queueWaitMs: 0, runMs: 0, totalMs: 0 },
    },
    current: { queued: [], running: null },
  };

  return {
    cancel: () => job,
    enqueue: (command: JobCommand, content: string) => {
      options.enqueued?.push({ command, content });
      return { ...job, command, contentLength: content.length, contentPreview: content };
    },
    getEvents: (): JobEvent[] => [],
    getJob: () => undefined,
    getMetricsSummary: () => metrics,
    onJobEvent: (_jobId: string, _listener: (event: JobEvent) => void) => () => undefined,
  };
}
