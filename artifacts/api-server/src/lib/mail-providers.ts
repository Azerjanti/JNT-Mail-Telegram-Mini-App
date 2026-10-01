import { createHash, randomBytes } from "node:crypto";

export type MailProviderName = "mailtm" | "mailgw" | "dropmail" | "guerrillamail" | "tempmaillol";
export type MailMessage = {
  id: string; sender: string; senderEmail?: string; subject: string; preview?: string;
  receivedAt: Date; isRead: boolean; verificationCode: string | null; html: string | null; text: string | null;
};
export type ProviderInbox = { provider: MailProviderName; address: string; state: Record<string, string>; expiresAt?: number };
export interface MailProvider {
  readonly name: MailProviderName;
  readonly pollIntervalMs: number;
  createInbox(): Promise<ProviderInbox>;
  listMessages(inbox: ProviderInbox): Promise<MailMessage[]>;
  getMessage(inbox: ProviderInbox, id: string): Promise<MailMessage | null>;
  deleteInbox(inbox: ProviderInbox): Promise<void>;
}

type ProviderRuntime = { provider: MailProvider; nextAt: number; active: number; cooldownUntil: number; failures: number; lastError: string | null };
export type ProviderStatus = { provider: MailProviderName; cooldownUntil: string | null; lastError: string | null; active: number };
export class ProviderPoolError extends Error {
  constructor(public readonly code: "PROVIDERS_BUSY" | "PROVIDERS_DOWN", public readonly retryAfterSeconds: number) { super(code); }
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const DEFAULTS: Record<MailProviderName, number> = { mailtm: 5, mailgw: 5, dropmail: 3, guerrillamail: 2, tempmaillol: 1 };
const TIMEOUT_MS = 8_000;
const MAX_CONCURRENT = 4;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function envRate(name: MailProviderName) {
  const value = Number(process.env[`MAIL_PROVIDER_${name.toUpperCase()}_RPS`]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULTS[name];
}
async function limited(runtime: ProviderRuntime, operation: () => Promise<Response>): Promise<Response> {
  while (runtime.active >= MAX_CONCURRENT) await sleep(25);
  const wait = runtime.nextAt - Date.now();
  if (wait > 0) await sleep(wait);
  runtime.nextAt = Date.now() + Math.ceil(1000 / envRate(runtime.provider.name));
  runtime.active += 1;
  try {
    const response = await operation();
    if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}`);
    runtime.failures = 0;
    return response;
  } finally { runtime.active -= 1; }
}
async function timedFetch(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
function jsonHeaders(extra: Record<string, string> = {}) { return { "content-type": "application/json", ...extra }; }

export function sanitizeHtml(value?: string): string | null {
  if (!value) return null;
  return value
    .replace(/<\s*(script|iframe|form|object|embed|base|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|form|object|embed|base|link|meta)[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, "")
    .replace(/\s+(src|href)\s*=\s*(['"])\s*(?!(?:https?:|mailto:|#|data:image\/))[\s\S]*?\2/gi, "")
    .replace(/\s+(src|href)\s*=\s*(['"])\s*https?:[\s\S]*?\2/gi, (match, attribute) => attribute.toLowerCase() === "href" ? match : "");
}
function entities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (_all, entity: string) => {
    if (entity[0] === "#") {
      const number = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _all;
    }
    return named[entity.toLowerCase()] ?? _all;
  });
}
function verificationCode(subject: string, text: string, html: string) {
  const matches = `${subject}\n${text}\n${html}`.match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [];
  return matches.find((candidate) => !/^(19|20)\d{2}$/.test(candidate)) ?? null;
}
function message(input: { id?: unknown; sender?: unknown; senderEmail?: unknown; subject?: unknown; text?: unknown; html?: unknown; date?: unknown }, isRead = false): MailMessage {
  const text = typeof input.text === "string" ? input.text : "";
  const rawHtml = Array.isArray(input.html) ? input.html.find((item) => typeof item === "string") ?? "" : typeof input.html === "string" ? input.html : "";
  const subject = entities(typeof input.subject === "string" && input.subject.trim() ? input.subject : "No subject");
  const senderEmail = typeof input.senderEmail === "string" ? input.senderEmail : "";
  const sender = entities(typeof input.sender === "string" && input.sender.trim() ? input.sender : senderEmail.split("@")[0] || "Unknown sender");
  return {
    id: String(input.id ?? createHash("sha1").update(`${senderEmail}|${subject}|${String(input.date)}`).digest("hex")), sender,
    ...(senderEmail ? { senderEmail } : {}), subject, preview: entities(text.replace(/\s+/g, " ").trim().slice(0, 140)) || undefined,
    receivedAt: new Date(typeof input.date === "string" || typeof input.date === "number" ? input.date : Date.now()), isRead,
    verificationCode: verificationCode(subject, text, rawHtml), html: sanitizeHtml(rawHtml), text: text || null,
  };
}
function mailApiMessage(raw: Record<string, unknown>, detail = false) {
  const from = typeof raw.from === "object" && raw.from ? raw.from as { name?: string; address?: string } : {};
  return message({ id: raw.id, sender: from.name, senderEmail: from.address, subject: raw.subject, text: raw.text ?? raw.intro, html: detail ? raw.html : undefined, date: raw.createdAt }, detail);
}

class MailApiProvider implements MailProvider {
  readonly pollIntervalMs = 5_000;
  constructor(readonly name: "mailtm" | "mailgw", private base: string) {}
  async createInbox() {
    const domainsResponse = await timedFetch(`${this.base}/domains?page=1`);
    if (!domainsResponse.ok) throw new HttpError(domainsResponse.status, `domains ${domainsResponse.status}`);
    const domains = await domainsResponse.json() as { "hydra:member"?: Array<{ domain?: string }>; member?: Array<{ domain?: string }> };
    const domain = (domains["hydra:member"] ?? domains.member ?? []).find((item) => item.domain)?.domain;
    if (!domain) throw new Error("No domain");
    const address = `jnt${Date.now().toString(36)}${randomBytes(3).toString("hex")}@${domain}`;
    const password = `${randomBytes(18).toString("base64url")}Jnt!9`;
    const accountResponse = await timedFetch(`${this.base}/accounts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address, password }) });
    if (!accountResponse.ok) throw new HttpError(accountResponse.status, `account ${accountResponse.status}`);
    const account = await accountResponse.json() as { id?: string };
    const tokenResponse = await timedFetch(`${this.base}/token`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ address, password }) });
    if (!tokenResponse.ok) throw new HttpError(tokenResponse.status, `token ${tokenResponse.status}`);
    const token = await tokenResponse.json() as { token?: string };
    if (!account.id || !token.token) throw new Error("Incomplete response");
    return { provider: this.name, address, state: { accountId: account.id, token: token.token } };
  }
  private headers(inbox: ProviderInbox) { return { authorization: `Bearer ${inbox.state.token}` }; }
  async listMessages(inbox: ProviderInbox) {
    const response = await timedFetch(`${this.base}/messages?page=1`, { headers: this.headers(inbox) });
    if (!response.ok) throw new HttpError(response.status, `messages ${response.status}`);
    const data = await response.json() as { "hydra:member"?: Array<Record<string, unknown>>; member?: Array<Record<string, unknown>> };
    return (data["hydra:member"] ?? data.member ?? []).map((item) => mailApiMessage(item));
  }
  async getMessage(inbox: ProviderInbox, id: string) {
    const response = await timedFetch(`${this.base}/messages/${encodeURIComponent(id)}`, { headers: this.headers(inbox) });
    if (response.status === 404) return null;
    if (!response.ok) throw new HttpError(response.status, `message ${response.status}`);
    return mailApiMessage(await response.json() as Record<string, unknown>, true);
  }
  async deleteInbox(inbox: ProviderInbox) { await timedFetch(`${this.base}/accounts/${encodeURIComponent(inbox.state.accountId)}`, { method: "DELETE", headers: this.headers(inbox) }); }
}

// DropMail disabled legacy arbitrary tokens in June 2026. It is enabled only
// when deployment supplies a current free token issued by DropMail.
const dropmailToken = process.env.DROPMAIL_TOKEN?.trim() || "";
class DropmailProvider implements MailProvider {
  readonly name = "dropmail" as const; readonly pollIntervalMs = 5_000;
  private endpoint = `https://dropmail.me/api/graphql/${dropmailToken}`;
  private async graphql(query: string, variables: Record<string, unknown> = {}) {
    const response = await timedFetch(this.endpoint, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw new HttpError(response.status, `graphql ${response.status}`);
    const value = await response.json() as { data?: Record<string, any>; errors?: unknown[] };
    if (value.errors?.length || !value.data) throw new Error("GraphQL response error");
    return value.data;
  }
  async createInbox() {
    const data = await this.graphql("mutation { introduceSession { id, expiresAt, addresses { address } } }");
    const session = data.introduceSession as { id?: string; expiresAt?: string; addresses?: Array<{ address?: string }> };
    const address = session.addresses?.[0]?.address;
    if (!session.id || !address) throw new Error("Incomplete response");
    return { provider: this.name, address, state: { sessionId: session.id }, expiresAt: session.expiresAt ? new Date(session.expiresAt).getTime() : undefined };
  }
  async listMessages(inbox: ProviderInbox) {
    const data = await this.graphql("query($id: ID!) { session(id: $id) { mails { id, fromAddr, fromName, headerSubject, text, html, receivedAt } } }", { id: inbox.state.sessionId });
    return ((data.session?.mails ?? []) as Array<Record<string, unknown>>).map((raw) => message({ id: raw.id, sender: raw.fromName, senderEmail: raw.fromAddr, subject: raw.headerSubject, text: raw.text, html: raw.html, date: raw.receivedAt }));
  }
  async getMessage(inbox: ProviderInbox, id: string) { return (await this.listMessages(inbox)).find((item) => item.id === id) ?? null; }
  async deleteInbox() { /* Dropmail sessions expire automatically. */ }
}

class GuerrillaProvider implements MailProvider {
  readonly name = "guerrillamail" as const; readonly pollIntervalMs = 10_000; private base = "https://api.guerrillamail.com/ajax.php";
  private async call(action: string, inbox?: ProviderInbox, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({ f: action, ip: process.env.GUERRILLA_IP || "127.0.0.1", agent: "JNTMail/1.0", ...extra });
    if (inbox?.state.sidToken) params.set("sid_token", inbox.state.sidToken);
    const response = await timedFetch(`${this.base}?${params}`);
    if (!response.ok) throw new HttpError(response.status, `${action} ${response.status}`);
    return await response.json() as Record<string, any>;
  }
  async createInbox() {
    const data = await this.call("get_email_address");
    if (!data.email_addr || !data.sid_token) throw new Error("Incomplete response");
    return { provider: this.name, address: data.email_addr, state: { sidToken: data.sid_token, sequence: "0" } };
  }
  async listMessages(inbox: ProviderInbox) {
    const data = await this.call("check_email", inbox, { seq: inbox.state.sequence || "0" });
    return ((data.list ?? []) as Array<Record<string, unknown>>).map((raw) => message({ id: raw.mail_id, sender: raw.mail_from, senderEmail: raw.mail_from, subject: raw.mail_subject, text: raw.mail_excerpt, date: Number(raw.mail_timestamp) * 1000 }));
  }
  async getMessage(inbox: ProviderInbox, id: string) {
    const raw = await this.call("fetch_email", inbox, { email_id: id });
    return raw.mail_id ? message({ id: raw.mail_id, sender: raw.mail_from, senderEmail: raw.mail_from, subject: raw.mail_subject, text: raw.mail_body, html: raw.mail_body, date: Number(raw.mail_timestamp) * 1000 }, true) : null;
  }
  async deleteInbox(inbox: ProviderInbox) { await this.call("forget_me", inbox); }
}

class TempMailLolProvider implements MailProvider {
  readonly name = "tempmaillol" as const; readonly pollIntervalMs = 10_000; private base = "https://api.tempmail.lol/v2";
  async createInbox() {
    const response = await timedFetch(`${this.base}/inbox/create`, { method: "POST", headers: jsonHeaders(), body: "{}" });
    if (!response.ok) throw new HttpError(response.status, `create ${response.status}`);
    const data = await response.json() as { address?: string; token?: string };
    if (!data.address || !data.token) throw new Error("Incomplete response");
    return { provider: this.name, address: data.address, state: { token: data.token } };
  }
  async listMessages(inbox: ProviderInbox) {
    const response = await timedFetch(`${this.base}/inbox?token=${encodeURIComponent(inbox.state.token)}`);
    if (!response.ok) throw new HttpError(response.status, `inbox ${response.status}`);
    const data = await response.json() as { emails?: Array<Record<string, unknown>> };
    return (data.emails ?? []).map((raw) => message({ id: raw.id, sender: raw.from, senderEmail: raw.from, subject: raw.subject, text: raw.body, html: raw.html, date: raw.date }));
  }
  async getMessage(inbox: ProviderInbox, id: string) { return (await this.listMessages(inbox)).find((item) => item.id === id) ?? null; }
  async deleteInbox() { /* No deletion endpoint is documented. */ }
}

const available: Record<MailProviderName, MailProvider> = {
  mailtm: new MailApiProvider("mailtm", "https://api.mail.tm"), mailgw: new MailApiProvider("mailgw", "https://api.mail.gw"),
  dropmail: new DropmailProvider(), guerrillamail: new GuerrillaProvider(), tempmaillol: new TempMailLolProvider(),
};
const configured = (process.env.MAIL_PROVIDERS || "mailtm,mailgw,dropmail,guerrillamail,tempmaillol")
  .split(",").map((value) => value.trim())
  .filter((value) => Object.prototype.hasOwnProperty.call(available, value))
  .filter((value) => value !== "dropmail" || dropmailToken.startsWith("af_")) as MailProviderName[];
const enabledNames: MailProviderName[] = configured.length ? configured : ["mailtm"];
const runtimes: ProviderRuntime[] = enabledNames.map((name) => ({ provider: available[name], nextAt: 0, active: 0, cooldownUntil: 0, failures: 0, lastError: null }));
let cursor = 0;
function fail(runtime: ProviderRuntime, error: unknown) {
  runtime.failures += 1;
  runtime.lastError = error instanceof Error ? error.message.slice(0, 120) : "Unknown provider error";
  runtime.cooldownUntil = Date.now() + Math.min(300_000, 60_000 * 2 ** (runtime.failures - 1));
}
function isBusy(error: unknown) { return error instanceof HttpError && error.status === 429; }
function shouldCool(error: unknown) { return isBusy(error) || !(error instanceof HttpError) || error.status >= 500; }
async function run<T>(runtime: ProviderRuntime, operation: () => Promise<T>) {
  try {
    const result = await limited(runtime, async () => {
      // Provider methods perform their own fetches; this response only lets the shared limiter wrap arbitrary work.
      const value = await operation();
      return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const wrapped = await result.json() as { value: T };
    return wrapped.value;
  } catch (error) { if (shouldCool(error)) fail(runtime, error); throw error; }
}
// Avoid Response serialization of Dates/Sets by using a direct limiter for provider operations.
async function invoke<T>(runtime: ProviderRuntime, operation: () => Promise<T>) {
  while (runtime.active >= MAX_CONCURRENT) await sleep(25);
  const wait = runtime.nextAt - Date.now(); if (wait > 0) await sleep(wait);
  runtime.nextAt = Date.now() + Math.ceil(1000 / envRate(runtime.provider.name)); runtime.active += 1;
  try { const value = await operation(); runtime.failures = 0; return value; }
  catch (error) { if (shouldCool(error)) fail(runtime, error); throw error; }
  finally { runtime.active -= 1; }
}
export async function createInbox(): Promise<ProviderInbox> {
  const start = cursor++ % runtimes.length;
  let down = 0;
  let busy = 0;
  for (let offset = 0; offset < runtimes.length; offset += 1) {
    const runtime = runtimes[(start + offset) % runtimes.length]!;
    if (runtime.cooldownUntil > Date.now()) { busy += 1; continue; }
    try { return await invoke<ProviderInbox>(runtime, () => runtime.provider.createInbox()); }
    catch (error) { if (isBusy(error)) busy += 1; else down += 1; }
  }
  const next = Math.min(...runtimes.map((item) => item.cooldownUntil || Date.now() + 60_000));
  const retry = Math.max(1, Math.ceil((next - Date.now()) / 1000));
  throw new ProviderPoolError(busy === runtimes.length || down === 0 ? "PROVIDERS_BUSY" : "PROVIDERS_DOWN", retry);
}
function runtimeFor(inbox: ProviderInbox): ProviderRuntime {
  const runtime = runtimes.find((item) => item.provider.name === inbox.provider);
  if (!runtime) throw new Error("Provider disabled");
  return runtime;
}
export function listMessages(inbox: ProviderInbox): Promise<MailMessage[]> {
  const runtime = runtimeFor(inbox);
  return invoke<MailMessage[]>(runtime, () => runtime.provider.listMessages(inbox));
}
export function getMessage(inbox: ProviderInbox, id: string): Promise<MailMessage | null> {
  const runtime = runtimeFor(inbox);
  return invoke<MailMessage | null>(runtime, () => runtime.provider.getMessage(inbox, id));
}
export async function deleteInbox(inbox: ProviderInbox): Promise<void> {
  const runtime = runtimeFor(inbox);
  try { await invoke<void>(runtime, () => runtime.provider.deleteInbox(inbox)); } catch { /* Expiry cleanup is best effort. */ }
}
export const pollInterval = (inbox: ProviderInbox) => runtimeFor(inbox).provider.pollIntervalMs;
export const providerStatuses = (): ProviderStatus[] => runtimes.map((runtime) => ({
  provider: runtime.provider.name,
  cooldownUntil: runtime.cooldownUntil > Date.now() ? new Date(runtime.cooldownUntil).toISOString() : null,
  lastError: runtime.lastError,
  active: runtime.active,
}));
