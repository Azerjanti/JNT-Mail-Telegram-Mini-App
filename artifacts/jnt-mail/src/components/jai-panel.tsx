import { useEffect, useRef, useState } from 'react';
import { Bot, Headphones, Loader2, Plus, Send, X } from 'lucide-react';
import type { Copy, Locale } from '@/lib/locales';
import { getTelegramWebApp } from '@/lib/telegram';

type Message = { role: 'user'|'assistant'; content: string; showSupport?: boolean; at?: number };
type Props = { locale: Locale; c: Copy; authorization: string; sessionActive: boolean; secondsLeft: number; refreshesUsed: number; lastErrorCode?: string };
function support(url = 'https://t.me/Azerjnt') {
  const app = getTelegramWebApp();
  if (app?.openTelegramLink) app.openTelegramLink(url); else if (app?.openLink) app.openLink(url); else window.open(url, '_blank', 'noopener,noreferrer');
}
function remainingTime(value: string | null) {
  if (!value) return '';
  const seconds = Math.max(0, Math.ceil((new Date(value).getTime()-Date.now())/1000));
  return `${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds%3600/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}
export function JaiPanel(props: Props) {
  const { c } = props; const [open,setOpen]=useState(false); const [loaded,setLoaded]=useState(false);
  const [messages,setMessages]=useState<Message[]>([]); const [text,setText]=useState(''); const [busy,setBusy]=useState(false);
  const [remaining,setRemaining]=useState(15); const [limit,setLimit]=useState(15); const [resetAt,setResetAt]=useState<string|null>(null);
  const [expiresAt,setExpiresAt]=useState<string|null>(null); const [supportUrl,setSupportUrl]=useState('https://t.me/Azerjnt'); const [notice,setNotice]=useState(''); const [,tick]=useState(0); const end=useRef<HTMLDivElement|null>(null);
  const headers={Authorization:props.authorization,'Content-Type':'application/json'};
  useEffect(()=>{const timer=window.setInterval(()=>tick(v=>v+1),1000);return()=>window.clearInterval(timer)},[]);
  useEffect(()=>{if(expiresAt&&new Date(expiresAt).getTime()<=Date.now()){setMessages([]);setExpiresAt(null);setNotice(c.jaiExpired)}},[expiresAt,c.jaiExpired]);
  useEffect(()=>{end.current?.scrollIntoView({behavior:'smooth'})},[messages,busy]);
  useEffect(()=>{
    if(!open||loaded)return; setLoaded(true);
    void fetch('/api/jai/history',{headers:{Authorization:props.authorization}}).then(async response=>{if(!response.ok)throw new Error();return response.json()}).then(data=>{setMessages(data.messages??[]);setRemaining(data.remaining??15);setLimit(data.limit??15);setResetAt(data.resetAt??null);setExpiresAt(data.expiresAt??null);setSupportUrl(data.supportUrl??'https://t.me/Azerjnt')}).catch(()=>setNotice(c.jaiResting));
  },[open,loaded,props.authorization,c.jaiResting]);
  async function send(value=text) {
    const message=value.trim(); if(!message||message.length>500||busy||remaining<=0)return; setText('');setBusy(true);setNotice('');setMessages(current=>[...current,{role:'user',content:message}]);
    try {
      const response=await fetch('/api/jai/chat',{method:'POST',headers,body:JSON.stringify({message,language:props.locale,sessionActive:props.sessionActive,secondsLeft:props.secondsLeft,refreshesUsed:props.refreshesUsed,lastErrorCode:props.lastErrorCode??null})});
      const data=await response.json(); setRemaining(data.remaining??remaining);setLimit(data.limit??limit);setResetAt(data.resetAt??resetAt);setExpiresAt(data.expiresAt??expiresAt);
      if(!response.ok){setMessages(current=>current.slice(0,-1));setNotice(data.code==='JAI_DAILY_LIMIT'?c.jaiLimit:c.jaiResting);return}
      setMessages(current=>[...current,{role:'assistant',content:data.message,showSupport:data.showSupport}]);
    } catch {setMessages(current=>current.slice(0,-1));setNotice(c.jaiResting)} finally {setBusy(false)}
  }
  async function fresh(){await fetch('/api/jai/chat',{method:'DELETE',headers:{Authorization:props.authorization}}).catch(()=>undefined);setMessages([]);setExpiresAt(null);setNotice('')}
  const quick=[c.jaiQuickMail,c.jaiQuickAddress,c.jaiQuickExpired];
  return <>
    <button type="button" onClick={()=>setOpen(true)} className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_35px_hsl(211_100%_50%/.35)]" aria-label={c.jaiTitle}><Bot className="h-6 w-6" /></button>
    {open?<div className="fixed inset-0 z-50 flex items-end bg-black/65 sm:items-center sm:justify-center" onMouseDown={event=>event.target===event.currentTarget&&setOpen(false)}>
      <section className="flex h-[min(88dvh,720px)] w-full flex-col rounded-t-2xl border border-border bg-background shadow-2xl sm:max-w-lg sm:rounded-2xl" role="dialog" aria-modal="true">
        <header className="border-b border-border px-4 pb-3 pt-[calc(.75rem+env(safe-area-inset-top))]">
          <div className="flex items-center justify-between"><div><h2 className="font-mono text-base font-semibold">{c.jaiTitle}</h2><p className="mt-1 text-[10px] text-muted-foreground">{c.jaiRemaining}: {remaining}/{limit}</p></div><div className="flex gap-1"><button onClick={()=>void fresh()} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary" aria-label={c.jaiNew}><Plus className="h-4 w-4" /></button><button onClick={()=>support(supportUrl)} className="inline-flex items-center gap-1 rounded-lg px-2 text-xs text-primary hover:bg-secondary"><Headphones className="h-4 w-4" />{c.support}</button><button onClick={()=>setOpen(false)} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary" aria-label={c.close}><X className="h-4 w-4" /></button></div></div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{c.jaiNotice}</p>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {messages.length===0?<div className="rounded-xl border border-border bg-card p-4 text-sm leading-6 text-secondary-foreground"><p>{c.jaiWelcome}</p><div className="mt-4 flex flex-wrap gap-2">{quick.map(item=><button key={item} onClick={()=>void send(item)} disabled={busy||remaining<=0} className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-primary disabled:opacity-40">{item}</button>)}</div></div>:null}
          <div className="space-y-3">{messages.map((item,index)=><div key={index} className={`flex ${item.role==='user'?'justify-end':'justify-start'}`}><div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-6 ${item.role==='user'?'bg-primary text-primary-foreground':'border border-border bg-card text-secondary-foreground'}`}><p className="whitespace-pre-wrap">{item.content}</p>{item.showSupport?<button onClick={()=>support(supportUrl)} className="mt-2 inline-flex items-center gap-1.5 border-t border-border/60 pt-2 text-xs font-medium text-primary"><Headphones className="h-3.5 w-3.5" />{c.supportContact}</button>:null}</div></div>)}</div>
          {busy?<div className="mt-3 flex w-fit items-center gap-1 rounded-xl border border-border bg-card px-3 py-2" aria-label={c.checking}><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"/><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:120ms]"/><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:240ms]"/></div>:null}
          {notice?<div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"><p>{notice}</p>{remaining<=0&&resetAt?<p className="mt-1 text-muted-foreground">{c.jaiReset}: {remainingTime(resetAt)}</p>:null}{notice===c.jaiExpired?<button onClick={()=>void fresh()} className="mt-2 mr-3 text-primary">{c.jaiNew}</button>:null}<button onClick={()=>support(supportUrl)} className="mt-2 text-primary">{c.supportContact}</button></div>:null}<div ref={end}/>
        </div>
        <form onSubmit={event=>{event.preventDefault();void send()}} className="flex items-end gap-2 border-t border-border p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]"><textarea value={text} onChange={event=>setText(event.target.value.slice(0,500))} onInput={event=>{event.currentTarget.style.height='auto';event.currentTarget.style.height=`${Math.min(event.currentTarget.scrollHeight,112)}px`}} rows={1} disabled={busy||remaining<=0} placeholder={c.jaiPlaceholder} className="max-h-28 min-h-11 flex-1 resize-none rounded-xl border border-border bg-card px-3 py-3 text-sm outline-none focus:border-primary disabled:opacity-50"/><button type="submit" disabled={busy||!text.trim()||remaining<=0} className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40" aria-label={c.jaiSend}>{busy?<Loader2 className="h-4 w-4 animate-spin"/>:<Send className="h-4 w-4"/>}</button></form>
      </section>
    </div>:null}
  </>;
}
