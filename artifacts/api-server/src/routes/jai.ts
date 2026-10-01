import { Router, type IRouter, type Response } from "express";
import { pool } from "@workspace/db";
import type { TelegramUser } from "../lib/telegram-auth";
import { JAI_SYSTEM_PROMPT } from "../lib/jai-knowledge";

type Role = "user" | "assistant";
type ChatMessage = { role: Role; content: string; showSupport?: boolean; at: number };
type Conversation = { messages: ChatMessage[]; lastUserMessageAt: number };
type ProxyError = Error & { status?: number; detail?: string };
const router: IRouter = Router();
const conversations = new Map<string, Conversation>();
const inFlight = new Set<string>();
const IDLE_MS = 13 * 60 * 1000;
const MAX_MESSAGES = Math.max(2, Number(process.env.JAI_HISTORY_MESSAGES) || 40);
const MAX_CHARS = Math.max(1000, Number(process.env.JAI_HISTORY_CHARS) || 12_000);
const USER_LIMIT = Math.max(1, Number(process.env.JAI_DAILY_PER_USER) || 15);
const DAILY_CAP = Math.max(1, Number(process.env.JAI_DAILY_CAP) || 3000);
let globalDay = new Date().toISOString().slice(0, 10);
let globalCount = 0;
let errorCount = 0;
let consecutiveErrors = 0;
let circuitUntil = 0;
let adaptiveMaxTokens = Math.max(50, Number(process.env.JAI_MAX_TOKENS) || 500);
let modelUnavailable = false;
let lastError: { code: number | string; message: string } | null = null;
let adminEnabled = true;

function user(res: Response) { return res.locals.telegramUser as TelegramUser | undefined; }
function enabled() { return process.env.JAI_ENABLED !== "false" && adminEnabled; }
export function setJaiAdminEnabled(value: boolean) { adminEnabled = value; }
function resetGlobalDay() { const today = new Date().toISOString().slice(0, 10); if (today !== globalDay) { globalDay = today; globalCount = 0; errorCount = 0; } }
function trim(messages: ChatMessage[]) {
  while (messages.length > MAX_MESSAGES || messages.reduce((sum, item) => sum + item.content.length, 0) > MAX_CHARS) messages.shift();
}
function clearExpired(id: string) { const chat = conversations.get(id); if (chat && Date.now() - chat.lastUserMessageAt >= IDLE_MS) conversations.delete(id); }
async function usage(id: string) {
  const result = await pool.query<{ used: number; window_start: Date }>("SELECT used, window_start FROM jai_usage WHERE telegram_id=$1", [id]);
  const row = result.rows[0];
  if (!row) return { used: 0, resetAt: null as string | null };
  const start = new Date(row.window_start).getTime();
  if (Date.now() - start >= 86_400_000) return { used: 0, resetAt: null };
  return { used: row.used, resetAt: new Date(start + 86_400_000).toISOString() };
}
async function reserve(id: string) {
  const result = await pool.query<{ used: number; window_start: Date }>(`
    INSERT INTO jai_usage (telegram_id,window_start,used) VALUES ($1,NOW(),1)
    ON CONFLICT (telegram_id) DO UPDATE SET
      window_start=CASE WHEN jai_usage.window_start<=NOW()-INTERVAL '24 hours' THEN NOW() ELSE jai_usage.window_start END,
      used=CASE WHEN jai_usage.window_start<=NOW()-INTERVAL '24 hours' THEN 1 ELSE jai_usage.used+1 END
    WHERE jai_usage.window_start<=NOW()-INTERVAL '24 hours' OR jai_usage.used<$2
    RETURNING used,window_start`, [id, USER_LIMIT]);
  const row = result.rows[0]; if (!row) return null;
  return { used: row.used, resetAt: new Date(new Date(row.window_start).getTime() + 86_400_000).toISOString() };
}
async function release(id: string) { await pool.query("UPDATE jai_usage SET used=GREATEST(0,used-1) WHERE telegram_id=$1", [id]); }
function responseMeta(id: string, used: number, resetAt: string | null) {
  const chat = conversations.get(id);
  const username = (process.env.SUPPORT_USERNAME || "Azerjnt").replace(/^@/, "");
  return { expiresAt: chat ? new Date(chat.lastUserMessageAt + IDLE_MS).toISOString() : null, remaining: Math.max(0, USER_LIMIT-used), limit: USER_LIMIT, resetAt, supportUrl: `https://t.me/${username}` };
}
function context(body: Record<string, unknown>) {
  const language = body.language === "tr" || body.language === "ru" || body.language === "en" ? body.language : "en";
  const sessionActive = body.sessionActive === true;
  const secondsLeft = Math.max(0, Math.min(600, Number(body.secondsLeft) || 0));
  const refreshesUsed = Math.max(0, Math.min(3, Number(body.refreshesUsed) || 0));
  const allowedErrors = new Set(["USER_RATE_LIMIT","PROVIDERS_BUSY","PROVIDERS_DOWN","DB_ERROR","UNKNOWN"]);
  const lastErrorCode = allowedErrors.has(String(body.lastErrorCode)) ? String(body.lastErrorCode) : "none";
  return `Verified app state: language=${language}; sessionActive=${sessionActive}; secondsLeft=${secondsLeft}; refreshesUsed=${refreshesUsed}; lastErrorCode=${lastErrorCode}. Do not infer any mailbox content.`;
}
function parseProxyError(status: number, payload: unknown): ProxyError {
  const value = payload as { detail?: unknown; error?: { message?: unknown } | string };
  const text = typeof value?.detail === "string" ? value.detail : typeof value?.error === "string" ? value.error : typeof value?.error?.message === "string" ? value.error.message : `HTTP ${status}`;
  return Object.assign(new Error(text.slice(0, 160)), { status, detail: text.slice(0, 160) });
}
async function proxy(messages: Array<{ role: "system"|Role; content: string }>) {
  const key = process.env.PROXYAPI_KEY;
  if (!key) throw Object.assign(new Error("ProxyAPI key is not configured"), { status: 503 });
  const model = process.env.JAI_MODEL || "google/gemini-2.0-flash";
  const maxTokens = adaptiveMaxTokens;
  let attempt429=0, attemptGateway=0;
  while (true) {
    const response = await fetch("https://api.proxyapi.ru/v1/chat/completions", { method:"POST", headers:{ authorization:`Bearer ${key}`, "content-type":"application/json" }, body:JSON.stringify({ model,messages,max_tokens:maxTokens }) });
    const payload = await response.json().catch(()=>({}));
    if (response.ok) {
      const result = payload as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      const content=result.choices?.[0]?.message?.content?.trim(); if(!content) throw Object.assign(new Error("Empty model response"),{status:502});
      const truncated = result.choices?.[0]?.finish_reason === "length";
      if (truncated) adaptiveMaxTokens = Math.min(2000, adaptiveMaxTokens * 2);
      return { content, truncated };
    }
    if(response.status===429 && attempt429<2){ await new Promise(r=>setTimeout(r,1000*2**attempt429++)); continue; }
    if((response.status===502||response.status===504)&&attemptGateway<1){ attemptGateway++; await new Promise(r=>setTimeout(r,1000)); continue; }
    throw parseProxyError(response.status,payload);
  }
}
function trip(error: ProxyError) {
  errorCount++; consecutiveErrors++; const status=error.status ?? "UNKNOWN"; lastError={code:status,message:(error.detail||error.message).slice(0,160)};
  const message=(error.detail||error.message).toLowerCase(); let duration=0;
  if(status===402) duration=600_000; else if(status===401||status===403) duration=1_800_000; else if(status===400||status===404) duration=3_600_000;
  if(status===404||message.includes("model not supported")||message.includes("model")&&message.includes("not found")) { duration=3_600_000; modelUnavailable=true; }
  if(consecutiveErrors>=10) duration=Math.max(duration,120_000); if(duration) circuitUntil=Math.max(circuitUntil,Date.now()+duration);
}
function resting(res: Response) { return res.status(503).json({ code:"JAI_RESTING", error:"jai_resting", retryAfterSeconds:Math.max(1,Math.ceil((circuitUntil-Date.now())/1000)), showSupport:true }); }

router.get("/jai/history",async(_req,res)=>{ const current=user(res); if(!current)return res.status(401).json({error:"unauthorized"}); clearExpired(current.id); const state=await usage(current.id); return res.json({messages:conversations.get(current.id)?.messages??[],...responseMeta(current.id,state.used,state.resetAt),enabled:enabled()}); });
router.delete("/jai/chat",async(_req,res)=>{ const current=user(res); if(!current)return res.status(401).json({error:"unauthorized"}); conversations.delete(current.id); const state=await usage(current.id); return res.json({ok:true,...responseMeta(current.id,state.used,state.resetAt)}); });
router.post("/jai/chat",async(req,res)=>{
  const current=user(res); if(!current)return res.status(401).json({error:"unauthorized"}); resetGlobalDay();
  if(!enabled()||globalCount>=DAILY_CAP||circuitUntil>Date.now()) return resting(res);
  const text=typeof req.body?.message==="string"?req.body.message.trim():""; if(!text||text.length>500)return res.status(400).json({code:"JAI_INVALID_MESSAGE",error:"invalid_message"});
  if(inFlight.has(current.id))return res.status(409).json({code:"JAI_REQUEST_ACTIVE",error:"request_active"});
  inFlight.add(current.id);
  let reservation: Awaited<ReturnType<typeof reserve>>;
  try { reservation=await reserve(current.id); }
  catch { inFlight.delete(current.id); return res.status(500).json({code:"JAI_USAGE_ERROR",error:"usage_unavailable"}); }
  if(!reservation){inFlight.delete(current.id);const state=await usage(current.id);return res.status(429).json({code:"JAI_DAILY_LIMIT",...responseMeta(current.id,state.used,state.resetAt)});}
  clearExpired(current.id); const chat=conversations.get(current.id)??{messages:[],lastUserMessageAt:Date.now()}; chat.messages.push({role:"user",content:text,at:Date.now()}); chat.lastUserMessageAt=Date.now(); trim(chat.messages); conversations.set(current.id,chat);
  try {
    const result=await proxy([{role:"system",content:JAI_SYSTEM_PROMPT},{role:"system",content:context(req.body as Record<string,unknown>)},...chat.messages.map(({role,content})=>({role,content}))]);
    let answer=result.content; const showSupport=answer.includes("[[SUPPORT]]"); answer=answer.replace(/\[\[SUPPORT\]\]/g,"").trim(); chat.messages.push({role:"assistant",content:answer,showSupport,at:Date.now()}); trim(chat.messages); consecutiveErrors=0; globalCount++;
    return res.json({message:answer,showSupport,truncated:result.truncated,...responseMeta(current.id,reservation.used,reservation.resetAt)});
  } catch(caught) { await release(current.id); chat.messages.pop(); const err=caught as ProxyError; trip(err); return resting(res); }
  finally { inFlight.delete(current.id); }
});
setInterval(()=>{ const now=Date.now(); for(const [id,chat] of conversations)if(now-chat.lastUserMessageAt>=IDLE_MS)conversations.delete(id); void pool.query("DELETE FROM jai_usage WHERE window_start<NOW()-INTERVAL '24 hours'").catch(()=>undefined); },30_000).unref();
export function jaiSummary(){resetGlobalDay();return{enabled:enabled(),todayMessages:globalCount,errorCount,circuitOpenUntil:circuitUntil>Date.now()?new Date(circuitUntil).toISOString():null,modelUnavailable:modelUnavailable&&circuitUntil>Date.now(),lastError};}
export default router;
