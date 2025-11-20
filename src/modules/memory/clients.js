import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const RUNTIME = path.join(process.cwd(), "_runtime");
const DIR     = path.join(RUNTIME, "clients");
const IDX     = path.join(DIR, "_by_phone.json");

function rd(p,def=null){ try{ return JSON.parse(readFileSync(p,"utf8")); }catch{ return def; } }
function wr(p,obj){ mkdirSync(path.dirname(p),{recursive:true}); writeFileSync(p, JSON.stringify(obj,null,2), "utf8"); }

export function getClientKey({domain,dialogId}){
  const d=String(domain||"local").replace(/[^a-z0-9_.-]/gi,"").toLowerCase();
  return `${d}::${dialogId}`;
}
function pKey(k){ return path.join(DIR, encodeURIComponent(k)+".json"); }

export function loadClient(k){ const p=pKey(k); if(!existsSync(p)) return null; return rd(p,null); }
export function saveClient(k,data){
  const now=new Date().toISOString();
  const obj = {
    key:k, first_seen:data.first_seen||now, last_seen:now,
    seen_count:(data.seen_count||0),
    name:data.name||null, phone:data.phone||null,
    last_oems:Array.isArray(data.last_oems)?data.last_oems.slice(-10):[],
    last_order:data.last_order||null, last_confirm_at:data.last_confirm_at||null,
    state:data.state||{awaiting:"none"}, lead_id:data.lead_id||null
  };
  mkdirSync(DIR,{recursive:true}); wr(pKey(k),obj);
  if(obj.phone) linkPhone(obj.phone,k);
  return obj;
}

function nPhone(p){ return String(p||"").replace(/[^\d+]/g,""); }
function loadIdx(){ return rd(IDX,{}); }
function saveIdx(x){ wr(IDX,x); }
export function findKeysByPhone(phone){
  const p=nPhone(phone); if(!p) return [];
  const idx=loadIdx(); return Array.isArray(idx[p])?idx[p]:[];
}
function linkPhone(phone,key){
  const p=nPhone(phone); if(!p) return;
  const idx=loadIdx(); const set=new Set(idx[p]||[]); set.add(key); idx[p]=[...set]; saveIdx(idx);
}

export function stripForwardHeaders(text){
  let t=String(text||"");
  t=t.replace(/^\s*переслан[оа]\s+от[^\n]*\n/iu," ")
     .replace(/^\s*переслан[оа]\s+из[^\n]*\n/iu," ")
     .replace(/^\s*пересланное\s+сообщение\s+от[^\n]*\n/iu," ")
     .replace(/^\s*forwarded\s+from[^\n]*\n/iu," ");
  t=t.replace(/^\s*(?:переслан[оа]\s+от|forwarded\s+from)\s+.+?(?:—|:)\s*/iu," ");
  return t;
}
export function normalizeName(s){
  const H=/[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/, A=/['\u2019\u02BC]/;
  return String(s||"").trim().replace(/\s+/g," ")
    .split(" ").map(p=>p.split(new RegExp("(" + H.source + "|" + A.source + ")","u"))
      .map(seg=>!seg?seg:(H.test(seg)||A.test(seg))?seg:seg[0].toUpperCase()+seg.slice(1).toLowerCase()).join(""))
    .join(" ");
}

const STOP = new Set([
  // приветствия / дежурные
  "здравствуйте","привет","добрый день","добрый","день","вечер","утро","спасибо",
  // подтверждения
  "да","верно","актуально","правильно","все верно","всё верно","ок","окей","ага","yes","yep","готово"
]);

export function extractContactFields(text){
  const t=stripForwardHeaders(String(text||""));
  const raw = (t.match(/(\+?\d[\d\s\-\(\)]{9,}\d)/) || [])[1] || null;
  let phone = raw ? raw.replace(/[^\d+]/g,"") : null;
  if (phone && phone.replace(/\D/g,"").length<11) phone=null;

  // имя: только Unicode-буквы (1–3 слова), флаг u
  let name = (t.match(/(?:меня\s+зовут|мо[её]\s+имя|имя[:\-]?)\s+([\p{L}][\p{L}'’\-]{1,30}(?:\s+[\p{L}][\p{L}'’\-]{1,30}){0,2})/iu) || [])[1] || null;
  if(!name){
    const m=t.match(/([\p{L}][\p{L}'’\-]{1,30}(?:\s+[\p{L}][\p{L}'’\-]{1,30}){0,2})/u);
    name = m? m[1] : null;
  }
  if(name){
    name=normalizeName(name);
    if (STOP.has(name.toLowerCase())) name=null;
  }
  return { phone, name };
}
export function pickNameSmart(text){ return extractContactFields(text).name; }