import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import {
  ensureJaiConversationTable,
  JAI_IDLE_MS,
} from "../src/lib/jai-conversations";

// The real PostgreSQL and ProxyAPI are never contacted by these tests.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/jai_tests";
process.env.PROXYAPI_KEY = "test-key-not-a-real-secret";
process.env.JAI_MODEL = "mistralai/mistral-nemo";
process.env.JAI_DAILY_PER_USER = "50";

const nativeFetch = globalThis.fetch;
type Payload = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
};
let postgres: PGlite;
let server: Server;
let baseUrl: string;
let requests: Payload[] = [];
let provider: (payload: Payload) => Promise<Response>;
let restoreQuery: () => void;
let restoreFetch: () => void;
let closePool: () => Promise<void>;

function completion(content = "JNT Mail konusunda size yardımcı olabilirim.") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

before(async () => {
  postgres = await PGlite.create();
  await ensureJaiConversationTable({
    query: (sql, values) => postgres.query(sql, values),
  });
  await postgres.exec(`CREATE TABLE jai_usage (
    telegram_id bigint PRIMARY KEY, window_start timestamptz NOT NULL,
    used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
  )`);
  const { pool } = await import("@workspace/db");
  const queryMock = mock.method(
    pool,
    "query",
    (sql: string, values?: unknown[]) => postgres.query(sql, values),
  );
  restoreQuery = () => queryMock.mock.restore();
  closePool = () => pool.end();
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      assert.equal(String(url), "https://api.proxyapi.ru/v1/chat/completions");
      assert.ok(
        options?.signal,
        "provider requests have a timeout shorter than the request lease",
      );
      const payload = JSON.parse(String(options?.body)) as Payload;
      requests.push(payload);
      return provider(payload);
    },
  );
  restoreFetch = () => fetchMock.mock.restore();
  const { default: router } = await import("../src/routes/jai");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = req.header("x-test-user");
    if (id) res.locals.telegramUser = { id, language: "tr" };
    next();
  });
  app.use("/api", router);
  server = app.listen(0, "0.0.0.0");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

beforeEach(async () => {
  await postgres.exec("TRUNCATE jai_conversations, jai_usage");
  requests = [];
  provider = async () => completion();
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  restoreFetch();
  restoreQuery();
  await closePool();
  await postgres.close();
});

async function call(
  path: string,
  options: { method?: string; body?: unknown; user?: string | null } = {},
) {
  const response = await nativeFetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.user !== null
        ? { "x-test-user": options.user ?? "101" }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, data: await response.json() };
}

function send(message: string, user = "101") {
  return call("/jai/chat", {
    method: "POST",
    body: { message, language: "tr" },
    user,
  });
}

test("a short follow-up sends all prior questions AND assistant replies to Nemo", async () => {
  provider = async () =>
    completion("Önce bir iki dakika bekleyip tekrar kontrol edin.");
  const first = await send("Mail gelmiyor, ne yapmalıyım?");
  assert.equal(first.status, 200);
  const second = await send("Bekledim ama hâlâ gelmedi. Yardım eder misin?");
  assert.equal(second.status, 200);
  assert.equal(requests[1].model, "mistralai/mistral-nemo");
  assert.equal(
    requests[1].messages.filter((message) => message.role === "system").length,
    1,
  );
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "user", content: "Mail gelmiyor, ne yapmalıyım?" },
    {
      role: "assistant",
      content: "Önce bir iki dakika bekleyip tekrar kontrol edin.",
    },
    { role: "user", content: "Bekledim ama hâlâ gelmedi. Yardım eder misin?" },
  ]);
  assert.equal(second.data.messages.length, 4);
  assert.deepEqual(
    (await call("/jai/history")).data.messages,
    second.data.messages,
  );
});

test("long active chats are not silently truncated in storage, history, or the provider payload", async () => {
  provider = async () => completion("Yanıt: " + "b".repeat(1500));
  let saved;
  for (let index = 0; index < 22; index++) {
    saved = await send(`Soru ${index}: ${"a".repeat(480)}`);
    assert.equal(saved.status, 200);
  }
  assert.equal(saved.data.messages.length, 44);
  assert.equal(requests.at(-1)?.messages.length, 44); // 1 system + 43 chat messages before the last reply.
  assert.ok(requests.at(-1)!.messages[1].content.startsWith("Soru 0:"));
  const history = await call("/jai/history");
  assert.deepEqual(history.data.messages, saved.data.messages);
});

test("reopening/reading history preserves the same deadline and allowance", async () => {
  const sent = await send("JAI'nin limitleri nedir?");
  const row = await postgres.query<{ last_user_message_at: Date }>(
    "SELECT last_user_message_at FROM jai_conversations",
  );
  assert.equal(
    Date.parse(sent.data.expiresAt) -
      new Date(row.rows[0].last_user_message_at).getTime(),
    JAI_IDLE_MS,
  );
  const reopened = await call("/jai/history");
  const reopenedAgain = await call("/jai/history");
  assert.equal(reopened.data.expiresAt, sent.data.expiresAt);
  assert.equal(reopenedAgain.data.expiresAt, sent.data.expiresAt);
  assert.equal(reopenedAgain.data.remaining, 49);
  assert.equal(requests.length, 1);
});

test("expired chats are cleared while daily allowance remains intact", async () => {
  const first = await send("İlk konuşma");
  await postgres.exec("UPDATE jai_conversations SET expires_at = NOW()");
  const expired = await call("/jai/history");
  assert.deepEqual(expired.data.messages, []);
  assert.equal(expired.data.expiresAt, null);
  assert.equal(expired.data.remaining, first.data.remaining);
  assert.equal(expired.data.resetAt, first.data.resetAt);
  const second = await send("Yeni konuşma");
  assert.equal(second.status, 200);
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "user", content: "Yeni konuşma" },
  ]);
  assert.equal(second.data.messages.length, 2);
  assert.equal(second.data.remaining, 48);
});

test("a provider failure never deletes a prior turn or consumes an allowance", async () => {
  const first = await send("Adresimin süresi doldu");
  provider = async () =>
    new Response(JSON.stringify({ detail: "Temporarily unavailable" }), {
      status: 503,
    });
  const failed = await send("Yardım eder misin?");
  assert.equal(failed.status, 503);
  assert.equal(failed.data.remaining, first.data.remaining);
  assert.ok(failed.data.expiresAt);
  assert.deepEqual(
    (await call("/jai/history")).data.messages,
    first.data.messages,
  );
  provider = async () => completion();
  const retry = await send("Yardım eder misin?");
  assert.equal(retry.status, 200);
  assert.deepEqual(
    requests.at(-1)!.messages.slice(1, 3),
    first.data.messages.map(
      ({ role, content }: { role: string; content: string }) => ({
        role,
        content,
      }),
    ),
  );
});

test("another user cannot read this user's history", async () => {
  await send("Birinci kullanıcıya özel soru");
  const other = await call("/jai/history", { user: "202" });
  assert.deepEqual(other.data.messages, []);
  await send("İkinci kullanıcı", "202");
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "user", content: "İkinci kullanıcı" },
  ]);
});

test("unauthenticated and invalid requests do not create or modify chat memory", async () => {
  assert.equal((await call("/jai/history", { user: null })).status, 401);
  assert.equal(
    (
      await call("/jai/chat", {
        method: "POST",
        body: { message: "Merhaba" },
        user: null,
      })
    ).status,
    401,
  );
  assert.equal((await send("a".repeat(501))).status, 400);
  assert.equal((await send("   ")).status, 400);
  assert.equal(
    (await postgres.query("SELECT * FROM jai_conversations")).rows.length,
    0,
  );
  assert.equal(requests.length, 0);
});

test("explicit new-chat deletion does not reset the message allowance", async () => {
  const sent = await send("Bir soru");
  const cleared = await call("/jai/chat", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data.messages, []);
  assert.equal(cleared.data.expiresAt, null);
  assert.equal(cleared.data.remaining, sent.data.remaining);
  const next = await send("Yeni soru");
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "user", content: "Yeni soru" },
  ]);
  assert.equal(next.data.remaining, 48);
});

test("reaching the allowance does not discard the existing conversation", async () => {
  const sent = await send("Bir soru");
  await postgres.exec("UPDATE jai_usage SET used = 50");
  const limited = await send("Başka bir soru");
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, "JAI_DAILY_LIMIT");
  assert.equal(limited.data.remaining, 0);
  assert.deepEqual(
    (await call("/jai/history")).data.messages,
    sent.data.messages,
  );
  assert.equal(requests.length, 1);
});

test("support markers are rendered as metadata while the assistant's reply remains in context", async () => {
  provider = async () =>
    completion("Destek ekibine ulaşabilirsiniz. [[SUPPORT]]");
  const sent = await send("Bir insana ulaşmak istiyorum");
  assert.equal(sent.status, 200);
  assert.equal(sent.data.showSupport, true);
  assert.equal(sent.data.messages[1].showSupport, true);
  assert.equal(sent.data.message, "Destek ekibine ulaşabilirsiniz.");
  await send("Nasıl ulaşırım?");
  assert.equal(
    requests[1].messages[2].content,
    "Destek ekibine ulaşabilirsiniz.",
  );
});

test("concurrent requests are rejected and a late reply cannot undo a new-chat deletion", async () => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const working = new Promise<void>((resolve) => {
    started = resolve;
  });
  provider = async () => {
    started();
    await pending;
    return completion();
  };
  const first = send("Bekleyen soru");
  await working;
  const concurrent = await send("Çakışan soru");
  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.data.code, "JAI_REQUEST_ACTIVE");
  assert.equal((await call("/jai/chat", { method: "DELETE" })).status, 200);
  release();
  const late = await first;
  assert.equal(late.status, 409);
  assert.equal(late.data.code, "JAI_CHAT_CHANGED");
  const history = await call("/jai/history");
  assert.deepEqual(history.data.messages, []);
  assert.equal(history.data.remaining, 50);
});
