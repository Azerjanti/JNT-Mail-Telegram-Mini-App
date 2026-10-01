import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import FakeTimers from "@sinonjs/fake-timers";

const IDLE_MS = 13 * 60 * 1000;
const start = Date.parse("2026-10-01T12:00:00Z");
let bundle: string;
let dom: JSDOM;
let window: any;
let clock: any;
let backend: {
  messages: Array<{ role: string; content: string; at: number }>;
  expiresAt: string | null;
  remaining: number;
  resetAt: string | null;
};
let historyReads: number;
let holdReply: Promise<void> | null;
let failDelete: boolean;

before(async () => {
  const frontendRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../jnt-mail",
  );
  const result = await build({
    stdin: {
      contents: `import { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { JaiPanel } from './src/components/jai-panel';
        import { copy } from './src/lib/locales';
        const root = createRoot(document.getElementById('root'));
        window.fixture = {
          act,
          render(locale = 'tr') {
            root.render(<JaiPanel locale={locale} c={copy[locale]} authorization="tma test"
              sessionActive={false} secondsLeft={0} refreshesUsed={0} />);
          },
          unmount() { root.unmount(); }
        };`,
      sourcefile: "jai-test.tsx",
      loader: "tsx",
      resolveDir: frontendRoot,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": path.join(frontendRoot, "src") },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  bundle = result.outputFiles[0].text;
});

beforeEach(async () => {
  dom = new JSDOM('<div id="root"></div>', {
    url: "https://jai.test/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  window = dom.window;
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  // React's act task queue needs a MessageChannel; DOM rendering needs no real network.
  window.MessageChannel = class {
    port1 = { onmessage: null as null | (() => void) };
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.()) };
  };
  clock = FakeTimers.withGlobal(window).install({
    now: start,
    toFake: ["Date", "setInterval", "clearInterval"],
  });
  backend = {
    messages: [
      { role: "user", content: "Önceki soru: mail gelmiyor", at: start },
      {
        role: "assistant",
        content: "Önceki cevap: bir iki dakika bekleyin",
        at: start,
      },
    ],
    expiresAt: new Date(start + IDLE_MS).toISOString(),
    remaining: 14,
    resetAt: new Date(start + 86_400_000).toISOString(),
  };
  historyReads = 0;
  holdReply = null;
  failDelete = false;
  const response = (extra = {}, status = 200) =>
    new Response(JSON.stringify({ ...backend, limit: 15, ...extra }), {
      status,
    });
  window.fetch = async (url: string, options: RequestInit = {}) => {
    if (url === "/api/jai/history") {
      historyReads++;
      if (
        backend.expiresAt &&
        Date.parse(backend.expiresAt) <= window.Date.now()
      ) {
        backend.messages = [];
        backend.expiresAt = null;
      }
      return response();
    }
    assert.equal(url, "/api/jai/chat");
    if (options.method === "DELETE") {
      if (failDelete) return response({ code: "JAI_HISTORY_ERROR" }, 500);
      backend.messages = [];
      backend.expiresAt = null;
      return response({ ok: true });
    }
    assert.equal(options.method, "POST");
    const { message } = JSON.parse(String(options.body));
    backend.expiresAt = new Date(window.Date.now() + IDLE_MS).toISOString();
    const user = { role: "user", content: message, at: window.Date.now() };
    if (holdReply) await holdReply;
    const answer = {
      role: "assistant",
      content: "Bağlama uygun yeni cevap",
      at: window.Date.now(),
    };
    backend.messages = [...backend.messages, user, answer];
    backend.remaining--;
    return response({ message: answer.content });
  };
  window.eval(bundle);
  await act(() => window.fixture.render());
});

afterEach(async () => {
  await act(() => window.fixture.unmount());
  clock.uninstall();
  dom.window.close();
});

async function act(action: () => void | Promise<void>) {
  await window.fixture.act(action);
}

function button(label: string): HTMLButtonElement {
  const found = window.document.querySelector(`button[aria-label="${label}"]`);
  assert.ok(found, `button ${label} exists`);
  return found;
}

async function open() {
  await act(() => button("JAI").click());
}

function content() {
  return window.document.body.textContent ?? "";
}

async function advance(milliseconds: number) {
  await act(() => {
    clock.tick(milliseconds);
  });
}

async function send(message: string) {
  const textarea = window.document.querySelector("textarea");
  assert.ok(textarea);
  await act(() => {
    // Native input events must update React state rather than just the DOM value.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, message);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(button("Gönder").disabled, false);
  await act(() => {
    window.document
      .querySelector("form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
  });
}

test("the panel clears history at 13 minutes without needing a new expiresAt prop", async () => {
  await open();
  assert.match(content(), /Önceki soru/);
  assert.match(content(), /Önceki cevap/);
  await advance(IDLE_MS - 1000);
  assert.match(content(), /Önceki soru/);
  await advance(1000);
  assert.doesNotMatch(content(), /Önceki soru|Önceki cevap/);
  assert.match(content(), /Sohbet süresi doldu/);
});

test("closing, reopening, and changing language never reset the last-user-message timer", async () => {
  await open();
  const deadline = backend.expiresAt;
  await advance(10 * 60 * 1000);
  await act(() => button("Kapat").click());
  await open();
  assert.equal(historyReads, 2);
  assert.equal(backend.expiresAt, deadline);
  assert.match(content(), /Önceki soru/);
  await act(() => window.fixture.render("en"));
  assert.equal(backend.expiresAt, deadline);
  await advance(3 * 60 * 1000);
  assert.doesNotMatch(content(), /Önceki soru/);
  assert.match(content(), /Chat expired/);
});

test("a new user message restarts the 13-minute timer and retains every previous message", async () => {
  await open();
  await advance(12 * 60 * 1000);
  await send("Bekledim, şimdi ne yapmalıyım?");
  assert.match(content(), /Önceki soru/);
  assert.match(content(), /Önceki cevap/);
  assert.match(content(), /Bekledim, şimdi ne yapmalıyım/);
  assert.match(content(), /Bağlama uygun yeni cevap/);
  await advance(2 * 60 * 1000);
  assert.match(content(), /Önceki soru/);
  await advance(11 * 60 * 1000);
  assert.doesNotMatch(content(), /Önceki soru|Bağlama uygun yeni cevap/);
  assert.match(content(), /Sohbet süresi doldu/);
});

test("sending just before expiry is protected from the old deadline; a delayed reply does not extend it", async () => {
  await open();
  await advance(12 * 60 * 1000);
  let resolve!: () => void;
  holdReply = new Promise<void>((done) => {
    resolve = done;
  });
  await send("Yeni takip sorusu");
  assert.equal(button("Yeni sohbet").disabled, true);
  const userDeadline = backend.expiresAt;
  await advance(2 * 60 * 1000);
  assert.match(content(), /Önceki soru/);
  assert.match(content(), /Yeni takip sorusu/);
  await act(async () => {
    resolve();
    await Promise.resolve();
  });
  assert.equal(backend.expiresAt, userDeadline);
  assert.match(content(), /Bağlama uygun yeni cevap/);
  await advance(11 * 60 * 1000);
  assert.doesNotMatch(content(), /Önceki soru|Yeni takip sorusu/);
});

test("a failed new-chat deletion preserves the visible and server-side conversation", async () => {
  await open();
  failDelete = true;
  await act(() => button("Yeni sohbet").click());
  assert.match(content(), /Önceki soru/);
  assert.equal(backend.messages.length, 2);
  assert.match(content(), /JAI şu an dinleniyor/);
});

test("resetting daily allowance does not erase a still-active conversation", async () => {
  backend.remaining = 0;
  backend.resetAt = new Date(start + 2000).toISOString();
  await open();
  assert.equal(window.document.querySelector("textarea").disabled, true);
  await advance(2000);
  assert.equal(window.document.querySelector("textarea").disabled, false);
  assert.match(content(), /Önceki soru/);
  assert.match(content(), /Kalan: 15\/15/);
});
