'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,scryptSync,timingSafeEqual}=require('node:crypto');
const {DATA_DIR,atomicWrite}=require('./storage');
const file=path.join(DATA_DIR,'admin.json');
const sessions=new Map(),failures=new Map();
function local(req) {return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);}
function protectedTransport(req) {return !!req.socket.encrypted || local(req);}
function configured() {return fs.existsSync(file);}
function session(req) {
  const id=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('schuetzen_session='))?.slice(18);
  const s=sessions.get(id);
  if(s && s.expires>Date.now()) return s;
  if(id) sessions.delete(id);return null;
}
function validateWrite(req) {
  if(['GET','HEAD'].includes(req.method)) return true;
  if(req.headers['x-schuetzen-request']!=='1') return false;
  const origin=req.headers.origin;
  return !origin || origin===`${req.socket.encrypted?'https':'http'}://${req.headers.host}`;
}
function setup(req,password) {
  if(!local(req) || configured()) throw new Error('Einrichtung ist nur einmal direkt am Server möglich');
  const hostname=new URL('http://'+req.headers.host).hostname;
  if(!['localhost','127.0.0.1','[::1]'].includes(hostname)) throw new Error('Einrichtung bitte über localhost öffnen');
  if(typeof password!=='string'||password.length<12||password.length>200) throw new Error('Kennwort muss 12 bis 200 Zeichen lang sein');
  const salt=randomBytes(16).toString('hex');
  atomicWrite(file,JSON.stringify({salt,hash:scryptSync(password,salt,64).toString('hex')}));
}
function login(req,res,password) {
  if(!protectedTransport(req) || !configured()) throw new Error('Für die Verwaltung ist lokal HTTP oder im LAN HTTPS erforderlich');
  const ip=req.socket.remoteAddress, f=failures.get(ip);
  if(f && f.until>Date.now() && f.count>=5) throw new Error('Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.');
  const credentials=JSON.parse(fs.readFileSync(file,'utf8'));
  const hash=scryptSync(typeof password==='string' ? password.slice(0,200) : '',credentials.salt,64);
  if(!timingSafeEqual(hash,Buffer.from(credentials.hash,'hex'))) {
    failures.set(ip,{count:f && f.until>Date.now() ? f.count+1 : 1,until:Date.now()+15*60000});
    throw new Error('Anmeldung fehlgeschlagen');
  }
  failures.delete(ip);
  for(const [key,s] of sessions) if(s.expires<=Date.now()) sessions.delete(key);
  const token=randomBytes(32).toString('hex');
  sessions.set(token,{expires:Date.now()+8*3600000});
  res.setHeader('Set-Cookie',`schuetzen_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.socket.encrypted?'; Secure':''}`);
}
function logout(req,res) {
  const token=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('schuetzen_session='))?.slice(18);
  sessions.delete(token);res.setHeader('Set-Cookie','schuetzen_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
function clearSessions() {sessions.clear();}
module.exports={local,protectedTransport,configured,session,validateWrite,setup,login,logout,clearSessions};
