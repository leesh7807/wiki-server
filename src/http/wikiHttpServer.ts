import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import { parseCommandContent } from "../jobs/jobCommand.js";
import type { JobStore } from "../jobs/jobStore.js";
import type { JobCommand, JobEvent, PublicJob } from "../jobs/jobTypes.js";
import { renderClientHtml } from "./clientHtml.js";

type HttpJobStore = Pick<
  JobStore,
  "cancel" | "enqueue" | "getEvents" | "getJob" | "getMetricsSummary" | "onJobEvent"
>;

export type WikiHttpServerOptions = {
  store: HttpJobStore;
  health: () => unknown;
  retrieval?: {
    token: string;
    search: (input: {
      query: string;
      command?: "query" | "ingest";
      maxCandidates?: number;
      maxHops?: 1 | 2;
    }) => unknown;
    read: (input: {
      path: string;
      heading?: string;
      startLine?: number;
      endLine?: number;
      full?: boolean;
    }) => unknown;
  };
  logger?: boolean;
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const retrievalSearchSchema = z.object({
  query: z.string().trim().min(1),
  command: z.enum(["query", "ingest"]).optional(),
  maxCandidates: z.number().int().min(1).max(24).optional(),
  maxHops: z.union([z.literal(1), z.literal(2)]).optional(),
}).strict();

const retrievalReadSchema = z.object({
  path: z.string().trim().min(1),
  heading: z.string().trim().min(1).optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  full: z.boolean().optional(),
}).strict();

/**
 * Owns the public HTTP contract. Process startup and concrete runner wiring stay
 * in the composition root so this transport can be tested or replaced alone.
 */
export function createWikiHttpServer(options: WikiHttpServerOptions) {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderClientHtml());
  });

  app.get("/client", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderClientHtml());
  });

  app.get("/health", async () => options.health());
  app.get("/metrics/jobs", async () => options.store.getMetricsSummary());

  app.post("/_internal/retrieval/search", async (request, reply) => {
    const retrieval = options.retrieval;
    if (!retrieval || !isInternalRetrievalRequest(retrieval.token, request.headers["x-wiki-retrieval-token"])) {
      return reply.code(404).send({ error: "not found" });
    }
    const parsed = retrievalSearchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid retrieval search request" });
    try {
      return retrieval.search(parsed.data);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/_internal/retrieval/read", async (request, reply) => {
    const retrieval = options.retrieval;
    if (!retrieval || !isInternalRetrievalRequest(retrieval.token, request.headers["x-wiki-retrieval-token"])) {
      return reply.code(404).send({ error: "not found" });
    }
    const parsed = retrievalReadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid retrieval read request" });
    try {
      return retrieval.read(parsed.data);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/ingest", async (request, reply) => {
    return enqueueCommand(options.store, "ingest", request.body, reply);
  });

  app.post("/query", async (request, reply) => {
    return enqueueCommand(options.store, "query", request.body, reply);
  });

  app.post("/lint", async (request, reply) => {
    return enqueueCommand(options.store, "lint", request.body, reply);
  });

  app.get("/jobs/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid job id" });
    }

    const job = options.store.getJob(params.data.id);
    if (!job) {
      return reply.code(404).send({ error: "job not found" });
    }

    return job;
  });

  app.get("/jobs/:id/events", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid job id" });
    }

    const job = options.store.getJob(params.data.id);
    if (!job) {
      return reply.code(404).send({ error: "job not found" });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();

    const send = (event: JobEvent["event"], data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("status", job);
    let sentDone = false;
    let replayComplete = false;
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const sentSeqs = new Set<number>();
    const liveBuffer: JobEvent[] = [];
    const sendJobEvent = (event: JobEvent) => {
      if (sentSeqs.has(event.seq)) return;
      sentSeqs.add(event.seq);
      send(event.event, event.data);
      if (event.event === "done") {
        sentDone = true;
      }
    };
    const closeStream = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      reply.raw.end();
    };
    unsubscribe = options.store.onJobEvent(params.data.id, (event) => {
      if (closed) return;
      if (!replayComplete) {
        liveBuffer.push(event);
        return;
      }
      sendJobEvent(event);
      if (sentDone) {
        closeStream();
      }
    });

    for (const event of options.store.getEvents(params.data.id)) {
      sendJobEvent(event);
    }
    replayComplete = true;
    for (const event of liveBuffer) {
      sendJobEvent(event);
    }
    liveBuffer.length = 0;

    if (isTerminalJob(job) || sentDone) {
      closeStream();
      return;
    }

    const latestJob = options.store.getJob(params.data.id);
    if (latestJob && isTerminalJob(latestJob)) {
      if (!sentDone) {
        send("done", latestJob);
        sentDone = true;
      }
      closeStream();
      return;
    }

    request.raw.on("close", () => {
      closeStream();
    });
  });

  app.post("/jobs/:id/cancel", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid job id" });
    }

    const job = options.store.cancel(params.data.id);
    if (!job) {
      return reply.code(404).send({ error: "job not found" });
    }

    return job;
  });

  return app;
}

function isInternalRetrievalRequest(
  expectedToken: string,
  token: string | string[] | undefined,
) {
  return typeof token === "string" && token === expectedToken;
}

function enqueueCommand(
  store: HttpJobStore,
  command: JobCommand,
  body: unknown,
  reply: FastifyReply,
) {
  const parsed = parseCommandContent(command, body);
  if (!parsed.ok) {
    return reply.code(400).send({ error: parsed.message });
  }

  const job = store.enqueue(command, parsed.content);
  return reply.code(202).send({
    jobId: job.id,
    status: job.status,
    eventsUrl: `/jobs/${job.id}/events`,
  });
}

function isTerminalJob(job: PublicJob) {
  return (
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "interrupted"
  );
}
