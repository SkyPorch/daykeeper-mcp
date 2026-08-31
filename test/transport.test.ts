import assert from "node:assert/strict";
import { test } from "node:test";
import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from "node:timers/promises";
import type { DaykeeperClient } from "@skyporch/daykeeper";
import {
  MAX_INPUT_BYTES,
  MAX_RESPONSE_BYTES,
  validateOptions,
} from "../src/config.ts";
import { createExecutor } from "../src/transport.ts";
import type { ToolMetadata } from "../src/tools.ts";
import {
  api,
  bounded,
  defaults,
  deferred,
  envelope,
  harness,
  KEY,
  PLAN,
  TOKEN,
} from "./helpers.ts";

const read: ToolMetadata = {
  name: "daykeeper_capabilities",
  effect: "read",
  scopes: ["daykeeper.accounts:read"],
  description: "Test read",
  idempotent: true,
  destructive: false,
};
const write: ToolMetadata = {
  name: "daykeeper_tenants_apply",
  effect: "mutation",
  scopes: ["daykeeper.provisioning:apply"],
  description: "Test apply",
  idempotent: true,
  destructive: false,
};
const plan: ToolMetadata = {
  ...write,
  name: "daykeeper_tenants_plan",
  effect: "plan",
  idempotent: false,
};
const config = validateOptions({
  ...defaults,
  timeoutMs: 1_000,
  enablePlanning: true,
  enableMutations: true,
});
const apply = (client: DaykeeperClient) =>
  client.tenants.apply(
    { planId: PLAN, planVersion: 1 },
    { idempotencyKey: KEY },
  );
const signal = () => new AbortController().signal;

for (const status of [401, 403, 404, 408, 409, 429, 500, 503]) {
  test(`API ${status}: no implicit retry, refresh or privileged fallback`, async () => {
    let calls = 0;
    const execute = createExecutor(config, async () => {
      calls++;
      return Response.json(
        {
          error: {
            code: "TEST_REJECTED",
            message: `private ${TOKEN}`,
            fields: ["planVersion", TOKEN, "secret with spaces"],
            nextActions: ["inspect_operation", TOKEN, "https://secret.test"],
            correlationId: "request-1",
            retryable: true,
          },
        },
        { status },
      );
    });
    const result = envelope(await execute(write, {}, apply, signal()));
    assert.equal(result.ok, false);
    assert.equal(result.error?.status, status);
    assert.equal(result.error?.correlationId, "request-1");
    assert.equal(calls, 1);
    assert.equal(
      result.error?.mutationOutcome,
      status === 408 || status >= 500 ? "unknown" : undefined,
    );
    if ([401, 403, 404].includes(status)) {
      assert.deepEqual(result.error?.fields, []);
      assert.deepEqual(result.error?.nextActions, []);
      assert.equal(result.error?.retryable, false);
    } else assert.deepEqual(result.error?.fields, ["planVersion"]);
    if (result.error?.mutationOutcome === "unknown") {
      assert(
        result.error.nextActions.includes("inspect_operation_before_retry"),
      );
      assert(
        result.error.nextActions.includes("reuse_original_idempotency_key"),
      );
    }
  });
}

test("network rejection and invalid JSON leave write outcome unknown without leaking diagnostics", async () => {
  for (const implementation of [
    async () => {
      throw new Error(`https://internal.test ${TOKEN}`);
    },
    async () => new Response(`private ${TOKEN}`),
    async () => api(null),
    async () => api(["not a resource"]),
    async () => Response.json({ missing: "data" }),
  ]) {
    let calls = 0;
    const execute = createExecutor(config, async () => {
      calls++;
      return implementation();
    });
    const result = envelope(await execute(write, {}, apply, signal()));
    assert.equal(result.ok, false);
    assert.equal(result.error?.mutationOutcome, "unknown");
    assert.equal(calls, 1);
    assert(!JSON.stringify(result).includes("internal.test"));
    assert(!JSON.stringify(result).includes("private"));
  }
});

test("planning is also a write; ambiguous results require inspection but no invented idempotency promise", async () => {
  const execute = createExecutor(config, async () => {
    throw new Error("uncertain plan persistence");
  });
  const result = envelope(
    await execute(
      plan,
      {},
      (client) =>
        client.tenants.plan({
          name: "Example company",
          slug: "example-company",
          locale: "en",
          administrator: { name: "Example owner", email: "owner@example.test" },
        }),
      signal(),
    ),
  );
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert.deepEqual(result.error?.nextActions, [
    "inspect_resource_before_retry",
  ]);
});

test("read failures never claim an unknown mutation outcome", async () => {
  const execute = createExecutor(config, async () => {
    throw new Error("network error");
  });
  const result = envelope(
    await execute(read, {}, (client) => client.capabilities(), signal()),
  );
  assert.equal(result.error?.mutationOutcome, undefined);
});

test("already cancelled work cannot dispatch and does not claim accepted mutation", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error(TOKEN));
  const execute = createExecutor(config, async () => {
    calls++;
    return api({});
  });
  const result = envelope(await execute(write, {}, apply, controller.signal));
  assert.equal(result.error?.code, "REQUEST_ABORTED");
  assert.equal(result.error?.mutationOutcome, undefined);
  assert.equal(calls, 0);
});

test("cancellation during SDK credential microtask prevents a late dispatch", async () => {
  let calls = 0;
  const controller = new AbortController();
  const execute = createExecutor(config, async () => {
    calls++;
    return api({});
  });
  const pending = execute(write, {}, apply, controller.signal);
  controller.abort();
  const result = envelope(await bounded(pending));
  await nextTurn();
  assert.equal(result.error?.code, "REQUEST_ABORTED");
  assert.equal(result.error?.mutationOutcome, undefined);
  assert.equal(calls, 0);
});

test("cancellation ignores non-cooperating transport and observes late rejection", async (context) => {
  const pending = deferred<Response>();
  const dispatched = deferred<void>();
  const controller = new AbortController();
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", listener);
  context.after(() => process.off("unhandledRejection", listener));
  const execute = createExecutor(config, (_url, init) => {
    assert(init?.signal);
    dispatched.resolve();
    return pending.promise;
  });
  const work = execute(write, {}, apply, controller.signal);
  await dispatched.promise;
  controller.abort();
  const result = envelope(await bounded(work));
  assert.equal(result.error?.code, "REQUEST_ABORTED");
  assert.equal(result.error?.mutationOutcome, "unknown");
  pending.reject(new Error(`private late rejection ${TOKEN}`));
  await nextTurn();
  assert.deepEqual(unhandled, []);
});

test("an absolute deadline bounds a transport that ignores cancellation", async () => {
  let calls = 0;
  let sentSignal: AbortSignal | null | undefined;
  const execute = createExecutor(config, (_url, init) => {
    calls++;
    sentSignal = init?.signal;
    return new Promise<Response>(() => undefined);
  });
  const result = envelope(await bounded(execute(write, {}, apply, signal())));
  assert.equal(result.error?.code, "REQUEST_TIMEOUT");
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert.equal(calls, 1);
  assert.equal(sentSignal?.aborted, true);
});

test("transport and body share one deadline; stalled cancellation cannot extend it", async () => {
  let cancelled = 0;
  let calls = 0;
  const execute = createExecutor(config, async () => {
    calls++;
    await delay(650);
    return new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: () => {
          cancelled++;
          return new Promise<void>(() => undefined);
        },
      }),
    );
  });
  const started = performance.now();
  const result = envelope(
    await bounded(execute(write, {}, apply, signal()), 1_500),
  );
  assert.equal(result.error?.code, "REQUEST_TIMEOUT");
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
  assert(performance.now() - started < 1_500);
});

test("late success is discarded and its cleanup rejection is observed", async () => {
  const pending = deferred<Response>();
  const dispatched = deferred<void>();
  const controller = new AbortController();
  let cancelled = 0;
  const execute = createExecutor(config, () => {
    dispatched.resolve();
    return pending.promise;
  });
  const work = execute(write, {}, apply, controller.signal);
  await dispatched.promise;
  controller.abort();
  const result = envelope(await bounded(work));
  pending.resolve(
    new Response(
      new ReadableStream({
        cancel: () => {
          cancelled++;
          return Promise.reject(new Error("private cleanup failure"));
        },
      }),
    ),
  );
  await nextTurn();
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert.equal(cancelled, 1);
});

for (const cleanup of ["throw", "reject", "never"] as const) {
  test(`oversize body stays bounded when cleanup will ${cleanup}`, async () => {
    let cancelled = 0;
    const execute = createExecutor(
      config,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
            },
            cancel() {
              cancelled++;
              if (cleanup === "throw") throw new Error("private cleanup");
              if (cleanup === "reject")
                return Promise.reject(new Error("private cleanup"));
              return new Promise<void>(() => undefined);
            },
          }),
        ),
    );
    const result = envelope(await bounded(execute(write, {}, apply, signal())));
    assert.equal(result.error?.code, "RESPONSE_TOO_LARGE");
    assert.equal(result.error?.mutationOutcome, "unknown");
    assert.equal(cancelled, 1);
    await nextTurn();
  });
}

test("actual bytes, not Content-Length, enforce response limits", async () => {
  const execute = createExecutor(
    config,
    async () =>
      new Response("x".repeat(MAX_RESPONSE_BYTES + 1), {
        headers: { "content-length": "1" },
      }),
  );
  const result = envelope(
    await execute(read, {}, (client) => client.capabilities(), signal()),
  );
  assert.equal(result.error?.code, "RESPONSE_TOO_LARGE");
});

test("oversize input and disabled writes fail before transport admission", async () => {
  let calls = 0;
  const execute = createExecutor(validateOptions(defaults), async () => {
    calls++;
    return api({});
  });
  const disabled = envelope(await execute(write, {}, apply, signal()));
  assert.equal(disabled.error?.code, "TOOL_DISABLED");
  const oversized = envelope(
    await execute(
      read,
      { value: "é".repeat(MAX_INPUT_BYTES) },
      (client) => client.capabilities(),
      signal(),
    ),
  );
  assert.equal(oversized.error?.code, "INPUT_TOO_LARGE");
  assert.equal(calls, 0);
});

test("four concurrent requests maximum, cancellation releases capacity, and results remain caller-local", async () => {
  let calls = 0;
  const active: Array<ReturnType<typeof deferred<Response>>> = [];
  const execute = createExecutor(config, () => {
    calls++;
    const pending = deferred<Response>();
    active.push(pending);
    return pending.promise;
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const results = controllers.map((controller) =>
    execute(read, {}, (client) => client.capabilities(), controller.signal),
  );
  await nextTurn();
  assert.equal(calls, 4);
  const fifth = envelope(
    await execute(read, {}, (client) => client.capabilities(), signal()),
  );
  assert.equal(fifth.error?.code, "LOCAL_CONCURRENCY_LIMIT");
  assert.equal(calls, 4);
  controllers[0].abort();
  assert.equal(envelope(await results[0]).error?.code, "REQUEST_ABORTED");
  const replacement = execute(
    read,
    {},
    (client) => client.capabilities(),
    signal(),
  );
  await nextTurn();
  assert.equal(calls, 5);
  for (const [index, pending] of active.entries())
    pending.resolve(api({ request: index }));
  assert.deepEqual(
    (await Promise.all(results.slice(1))).map(
      (result) => envelope(result).data,
    ),
    [{ request: 1 }, { request: 2 }, { request: 3 }],
  );
  assert.deepEqual(envelope(await replacement).data, { request: 4 });
});

test("redirected custom transport response is discarded without consuming its body", async () => {
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      cancel: () => {
        cancelled++;
      },
    }),
  );
  Object.defineProperty(response, "redirected", { value: true });
  const execute = createExecutor(config, async () => response);
  const result = envelope(await execute(write, {}, apply, signal()));
  assert.equal(result.error?.code, "REDIRECT_REJECTED");
  assert.equal(result.error?.mutationOutcome, "unknown");
  assert.equal(cancelled, 1);
});

test("protocol cancellation aborts the underlying SDK request without replay", async (context) => {
  const dispatched = deferred<void>();
  let calls = 0;
  let requestSignal: AbortSignal | null | undefined;
  const client = await harness(context, {
    fetch: (_input, init) => {
      calls++;
      requestSignal = init?.signal;
      dispatched.resolve();
      return new Promise<Response>(() => undefined);
    },
  });
  const controller = new AbortController();
  const work = client.callTool(
    { name: "daykeeper_capabilities", arguments: {} },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(work);
  await dispatched.promise;
  controller.abort();
  await bounded(rejected);
  await nextTurn();
  assert.equal(requestSignal?.aborted, true);
  assert.equal(calls, 1);
});
