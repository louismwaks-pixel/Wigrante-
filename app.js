/* WIGRANTE connection layer (Stage 1). Load AFTER the Supabase script:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
   <script src="wigrante-api.js"></script>
   Everything is on window.W. Keys below are PUBLIC keys: safe to be in the page. */

const SUPABASE_URL = "https://ezegofsvlfdklyyduafe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6ZWdvZnN2bGZka2x5eWR1YWZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5NDUxMTAsImV4cCI6MjExMDUyMTExMH0.de6BztB3ZJN0ay_F-lMEUjaoWx-Z3MfA59GWT4OOCG0";
const PAYSTACK_PUBLIC_KEY = "pk_live_65fc19152884ec5c6306fdd96ade3f9f3f0faa9e";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const W = {
  sb, PAYSTACK_PUBLIC_KEY,

  /* ---------- LOGIN ---------- */
  async user() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
  async signUp(email, password) { const d = ok(await sb.auth.signUp({ email, password })); return d.user; },
  async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })).user; },
  async signOut() { await sb.auth.signOut(); },

  /* ---------- FILES (photos / videos go to Storage, not the database) ---------- */
  async upload(file, uid) {
    const ext = (file.name && file.name.includes(".") ? file.name.split(".").pop() : (file.type.split("/")[1] || "bin")).toLowerCase();
    const path = `${uid}/${crypto.randomUUID()}.${ext}`;
    ok(await sb.storage.from("media").upload(path, file, { contentType: file.type }));
    return { url: sb.storage.from("media").getPublicUrl(path).data.publicUrl, type: file.type.startsWith("video") ? "video" : "image" };
  },
  async uploadAll(files, uid) { const out = []; for (const f of files) out.push(await W.upload(f, uid)); return out; },

  /* ---------- WISHING ACCOUNT ---------- */
  async myProfile() { const u = await W.user(); if (!u) return null; return ok(await sb.from("profiles").select("*").eq("id", u.id).maybeSingle()); },
  async saveProfile(p, picFile) {          // p = {name,country,age,gender}; picFile optional File/Blob
    const u = await W.user(); if (!u) throw new Error("Please log in first.");
    let pic_url = p.pic_url;
    if (picFile) pic_url = (await W.upload(picFile, u.id)).url;
    const row = { name: p.name, country: p.country, age: +p.age, gender: p.gender, pic_url };
    const have = await W.myProfile();
    if (have) ok(await sb.from("profiles").update(row).eq("id", u.id));
    else ok(await sb.from("profiles").insert({ id: u.id, ...row }));
    return W.myProfile();
  },
  async deleteAccount() { ok(await sb.rpc("delete_account")); await sb.auth.signOut(); },
  ping() { W.user().then(u => u && sb.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", u.id)); },
  isOnline(p) { return !!p && !!p.last_seen && Date.now() - new Date(p.last_seen).getTime() < 120000; },

  /* ---------- WISHES ---------- */
  WISH_SELECT: "*, owner:profiles!wishes_wisher_id_fkey(id,name,country,age,gender,pic_url,last_seen)",
  async createWish({ title, body, files }) {  // files = real File objects (max 2 photos + 1 video)
    const u = await W.user(); const media = await W.uploadAll(files || [], u.id);
    try { return ok(await sb.from("wishes").insert({ wisher_id: u.id, title, body, media }).select().single()); }
    catch (e) { if (/WISH_LIMIT/.test(e.message)) e.limit = true; if (/DAILY_LIMIT/.test(e.message)) e.daily = true; throw e; }   // limit = time to pay $2 for 20 more
  },
  async editWish(id, { title, body, keep, files }) {   // keep = media already saved, files = new File objects
    const u = await W.user(); const media = [...(keep || []), ...(await W.uploadAll(files || [], u.id))];
    return ok(await sb.from("wishes").update({ title, body, media }).eq("id", id).select().single());
  },
  async deleteWish(id) { ok(await sb.from("wishes").delete().eq("id", id)); },
  async myWishes() { const u = await W.user(); return ok(await sb.from("wishes").select(W.WISH_SELECT).eq("wisher_id", u.id).order("created_at", { ascending: false })); },
  async feed(n = 30) { return ok(await sb.rpc("feed", { n }).select(W.WISH_SELECT)); },   // random mix every time
  async search(q) { return ok(await sb.rpc("search_wishes", { q }).select(W.WISH_SELECT)); },
  async setBackground(id, bg) { ok(await sb.from("wishes").update({ background: bg }).eq("id", id)); },

  /* ---------- CHAT ---------- */
  async messages(wishId) { return ok(await sb.from("messages").select("*").eq("wish_id", wishId).order("created_at")); },
  async sendMsg(wishId, body, media) { const u = await W.user(); ok(await sb.from("messages").insert({ wish_id: wishId, sender_id: u.id, body, media })); },
  async editMsg(id, body, media) { ok(await sb.from("messages").update({ body, media, edited_at: new Date().toISOString() }).eq("id", id)); },
  async delMsg(id) { ok(await sb.from("messages").delete().eq("id", id)); },
  async markRead(wishId) { await sb.rpc("mark_read", { p_wish: wishId }); },
  async unread() { const u = await W.user(); return ok(await sb.from("messages").select("wish_id").is("read_at", null).neq("sender_id", u.id)); },
  subscribe(wishId, onMsg, onTyping) {
    return sb.channel("chat-" + wishId)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: "wish_id=eq." + wishId }, () => onMsg())
      .on("broadcast", { event: "typing" }, ({ payload }) => onTyping(payload.uid))
      .subscribe();
  },
  typing(ch, uid) { ch.send({ type: "broadcast", event: "typing", payload: { uid } }); },
  unsub(ch) { sb.removeChannel(ch); },
  async myGranter() { const u = await W.user(); return ok(await sb.from("granters").select("*").eq("user_id", u.id).maybeSingle()); },
  async granterInfo(id) { return ok(await sb.from("granters").select("*").eq("user_id", id).maybeSingle()); },
  async profileInfo(id) { return ok(await sb.from("profiles").select("*").eq("id", id).maybeSingle()); },
  async report(wishId) { const u = await W.user(); ok(await sb.from("reports").insert({ wish_id: wishId, reporter_id: u.id })); },

  async wishGranter(id) { return ok(await sb.from("wishes").select("granter_id").eq("id", id).single()).granter_id; },
  async ranking() { return ok(await sb.from("ranking").select("*").order("position").limit(100)); },
  async myRank(uid) { return ok(await sb.from("ranking").select("position,fulfilled").eq("user_id", uid).maybeSingle()); },

  async saveGranter(g, picFile) {
    const u = await W.user(); let pic_url = g.pic_url;
    if (picFile) pic_url = (await W.upload(picFile, u.id)).url;
    const row = { name: g.name, country: g.country, age: +g.age, gender: g.gender, business: g.business, pic_url };
    if (await W.myGranter()) ok(await sb.from("granters").update(row).eq("user_id", u.id));
    else ok(await sb.from("granters").insert({ user_id: u.id, ...row }));
    return W.myGranter();
  },
  async deleteGranter() { const u = await W.user(); ok(await sb.from("granters").delete().eq("user_id", u.id)); },
  async ownedBgs() { return ok(await sb.from("owned_backgrounds").select("background")).map(x => x.background); },

  async notifs() { return ok(await sb.from("notifications").select("*").order("created_at", { ascending: false })); },
  async delNotifs(ids) { ok(await sb.from("notifications").delete().in("id", ids)); },
  async fulfilled() { const u = await W.user(); return ok(await sb.from("wishes").select("id, owner:profiles!wishes_wisher_id_fkey(id,name,country,age,gender,pic_url)").eq("granter_id", u.id).eq("done", true)); },
  async setDone(id, d) { ok(await sb.rpc("set_done", { p_wish: id, p_done: d })); },
  async unlockable() { return ok(await sb.rpc("my_unlockable")); },
  async releaseLock(id) { ok(await sb.rpc("release_lock", { p_wish: id })); },

  /* ---------- LIKES / SAVES / COMMENTS ---------- */
  async likesFor(ids) { return ok(await sb.from("likes").select("wish_id,user_id").in("wish_id", ids)); },
  async toggleLike(wishId, liked) {
    const u = await W.user();
    if (liked) ok(await sb.from("likes").delete().eq("wish_id", wishId).eq("user_id", u.id));
    else ok(await sb.from("likes").insert({ wish_id: wishId, user_id: u.id }));
  },
  async mySaves() { const u = await W.user(); return ok(await sb.from("saves").select("wish_id, wish:wishes(" + W.WISH_SELECT + ")").eq("user_id", u.id).order("wish_id")); },
  async toggleSave(wishId, saved) {
    const u = await W.user();
    if (saved) ok(await sb.from("saves").delete().eq("wish_id", wishId).eq("user_id", u.id));
    else ok(await sb.from("saves").insert({ wish_id: wishId, user_id: u.id }));
  },
  async comments(wishId) { return ok(await sb.from("comments").select("*, author:profiles(id,name,pic_url)").eq("wish_id", wishId).order("created_at", { ascending: false })); },
  async commentsFor(ids) { return ok(await sb.from("comments").select("*, author:profiles(id,name,pic_url)").in("wish_id", ids)); },
  async addComment(wishId, { supports, body, files, media: pre }) {   // one comment per person per wish
    const u = await W.user(); const media = [...(pre || []), ...(await W.uploadAll(files || [], u.id))];
    return ok(await sb.from("comments").insert({ wish_id: wishId, user_id: u.id, supports, body, media }));
  },
  async editComment(id, { body, media }) { ok(await sb.from("comments").update({ body, media, edited_at: new Date().toISOString() }).eq("id", id)); },
  async deleteComment(id) { ok(await sb.from("comments").delete().eq("id", id)); }
};

window.W = W;
setInterval(() => W.ping(), 60000);   // keeps the green "online" dot alive

const PUB=[{id:'bg-free',name:'Clean White',price:0,css:'linear-gradient(180deg,#ffffff 0%,#f3f4fc 100%)'},{id:'bg-blue',name:'Blue Dream',price:2,css:'linear-gradient(180deg,#0000a0 0%,#4a4aff 50%,#a0a0ff 100%)'}];
const $=i=>document.getElementById(i);
const S=()=>[...document.querySelectorAll('.s')],fd=$('fd');
const urlCache=new WeakMap();
const blobUrl=f=>{if(f.url)return f.url;let u=urlCache.get(f);if(!u){u=URL.createObjectURL(f);urlCache.set(f,u)}return u};
const pauseAll=except=>{document.querySelectorAll('video,audio').forEach(v=>{if(v!==except&&!v.paused){try{v.pause()}catch{}}})};
const playSafe=el=>{if(!el)return;try{let p=el.play();if(p&&p.catch)p.catch(()=>{})}catch{}};
const go=n=>{let target=$('s'+n);if(!target)return;S().forEach(s=>s.classList.toggle('on',s===target));if(n!=6){bu.forEach(rv);bu=[]}if(n==9)renderRank();if(n==5){drawSv();paintBadges();checkNotifs();let tp=$('tp');if(tp)tp.scrollLeft=tabi*tp.clientWidth}scrollTo(0,0)};
let wc={},db,acc,pic="",ed=0,pw,ew=0,ws=[],rx={},vo=0,cw,sup=1,ec=0,tabi=0,bgs=[],bu=[],icb,wcur=null,goToFeedAfterLoad=false,cmMediaList=[],chMediaList=[],searchTimeout;

const ask=(msg,typ,cb,lbl)=>{$('mm').textContent=msg;$('mi').style.display=typ?'block':'none';$('mi').value='';$('my').disabled=!!typ;$('my').textContent=lbl||'Delete';icb=cb;$('md').classList.add('sh');if(typ)$('mi').focus()},mx=()=>$('md').classList.remove('sh'),toast=m=>{let x=$('tt');x.textContent=m;x.classList.remove('go');void x.offsetWidth;x.classList.add('go')};
$('mi').oninput=()=>$('my').disabled=$('mi').value.trim().toUpperCase()!=="DELETE";$('my').onclick=()=>{mx();icb&&icb()};
const mergeBgs=()=>{bgs=[...PUB]};mergeBgs();
function render(){if(!acc)return;$('h-name').textContent=acc.name;$('h-pic').style.display=acc.pic?'block':'none';if(acc.pic)$('h-pic').src=acc.pic}

const draw=()=>{
  let f=document.createDocumentFragment();
  (ws||[]).sort((a,b)=>b.ts-a.ts).forEach(w=>{
    let r=document.createElement('div');r.className='wr';r.dataset.id=w.id;
    r.innerHTML=`<div class="w-badge">0 message</div><span class="wt"><span class="wt-cb${w.done?' on':''}" onclick="event.stopPropagation();tickWish('${w.id}')">${w.done?'✓':''}</span><span class="wt-t"></span></span><span class="wb"><b onclick="ewish('${w.id}')">edit</b><b class="d" onclick="dwish('${w.id}')">del</b></span>`;
    r.querySelector('.wt-t').textContent=w.title;f.append(r)
  });
  $('wl').replaceChildren(f);drawSv()
};
$('wl').onclick=e=>{let r=e.target.closest('.wr');if(r&&!e.target.closest('.wb')&&!e.target.closest('.wt-cb'))openWish(r.dataset.id)};
const ewish=id=>{let w=ws.find(x=>x.id==id);if(!w)return;ew=id;$('txt').value=w.text;t.value=w.title;$('main-pv').innerHTML='';(w.files||[]).forEach(addPv);go(2)};
const dwish=id=>ask("Delete this wish?",0,async()=>{try{await W.deleteWish(id);ws=ws.filter(x=>x.id!=id);delete rx[id];draw()}catch(e){alert(e.message)}});
const mk=()=>({id:ew||Date.now(),title:t.value.trim(),text:$('txt').value.trim(),files:[...$('main-pv').children].map(d=>d.f)});
const clr=()=>{$('txt').value='';t.value='';$('main-pv').innerHTML=''};
const fin=async()=>{let w=pw,id=ew;pw=null;ew=0;try{if(id)await W.editWish(id,{title:w.title,body:w.text,keep:w.files.filter(f=>f.url),files:w.files.filter(f=>!f.url)});else await W.createWish({title:w.title,body:w.text,files:w.files});await loadMine();clr();go(5)}catch(e){pw=w;ew=id;if(e.limit)ask("You have used your 20 free wishes. Pay 2$ for 20 more wishes?",0,()=>payFor('wish_pack',{},async()=>{await fin()}),'Pay');else alert(e.daily?'You can post only 3 wishes a day. Come back tomorrow.':e.message)}};
const tabTo=k=>{tabi=k;let tp=$('tp');if(tp)tp.scrollTo({left:k*tp.clientWidth,behavior:'smooth'})};
$('tp').onscroll=()=>{let p=$('tp');if(!p||!p.clientWidth)return;tabi=Math.round(p.scrollLeft/p.clientWidth);document.querySelectorAll('.tab').forEach((x,i)=>x.classList.toggle('cur',i==tabi))};
const sv=()=>rx.saved||(rx.saved={id:'saved',ids:[]}),bt=()=>rx.bought||(rx.bought={id:'bought',ids:[]}),svL=()=>[...sv().ids].reverse().map(id=>wc[id]).filter(Boolean);
function drawSv(){bu.forEach(u=>URL.revokeObjectURL(u));bu=[];let l=svL(),f=document.createDocumentFragment();l.forEach(w=>{let c=document.createElement('div'),x=(w.files||[])[0],s=document.createElement('span');c.className='sc';c.dataset.id=w.id;s.textContent=w.title;if(x){let u=x.url||URL.createObjectURL(x),v=x.type.startsWith('video'),m=document.createElement(v?'video':'img');bu.push(u);if(v){m.muted=true;m.playsInline=true;m.preload='metadata'}else m.decoding='async';m.src=v?u+'#t=0.1':u;c.append(m)}else c.classList.add('nt');c.append(s);f.append(c)});$('sg').replaceChildren(f);if(!l.length)$('sg').innerHTML='<div class="em">Tap the bookmark on a wish to save it.</div>'}
$('sg').onclick=e=>{let c=e.target.closest('.sc');c&&openFeed(svL(),c.dataset.id)};
const tgS=id=>{let s=sv(),k=s.ids.indexOf(id);k<0?s.ids.push(id):s.ids.splice(k,1);W.toggleSave(id,k>=0).catch(()=>toast('Could not save'));toast(k<0?'Saved':'Removed from saved');drawSv();fd.querySelectorAll('.wi').forEach(upd)};
const addPv=f=>{let u=f.url||URL.createObjectURL(f),v=f.type.startsWith('video'),a=f.type.startsWith('audio'),d=document.createElement('div');d.className='pv';d.f=f;d.innerHTML=`${v?`<video src="${u}" muted autoplay loop playsinline preload="metadata"></video>`:a?`<div style="width:100%;height:100%;display:flex;justify-content:center;align-items:center;background:#0000a0;color:#fff;font-size:.7rem">♪</div>`:`<img src="${u}" decoding="async">`}<button onclick="this.parentElement.remove()">x</button>`;$('main-pv').append(d)};
const photoVideoFiles=files=>[...files].filter(f=>f.type.startsWith('image/')||f.type.startsWith('video/'));
$('file-main').onchange=e=>{
  let files=photoVideoFiles(e.target.files); e.target.value='';
  if(!files.length) return;
  
  let currentFiles=[...$('main-pv').children].map(d=>d.f);
  let currentVideo=currentFiles.filter(f=>f.type.startsWith('video')).length;
  let currentImage=currentFiles.filter(f=>f.type.startsWith('image')).length;
  
  for(let f of files) {
    let isV=f.type.startsWith('video'), isI=f.type.startsWith('image');
    if(isV) { if(currentVideo >= 1) { toast("Max 1 video allowed."); continue; } currentVideo++; }
    else if(isI) { if(currentImage >= 2) { toast("Max 2 photos allowed."); continue; } currentImage++; }
    addPv(f);
  }
};
const n2=()=>{if(!$('txt').value.trim()&&!$('main-pv').children.length)return alert("Please write your wish or upload a photo/video.");go(3)};
const back2=()=>{ew=0;if(acc){clr();go(5)}else go(1)};
let i=0,ph=["Ocad Wish","New Laptop","Startup Capital","Trip to New York"],t=$('title-input');
setInterval(()=>{if(t.value.trim()||!$('s3').classList.contains('on'))return;t.style.opacity=0;setTimeout(()=>{i=(i+1)%ph.length;t.placeholder=ph[i];t.style.opacity=1},300)},3000);
const n3=()=>{if(!t.value.trim())return alert("Please give your wish a title.");pw=mk();acc?fin():go(4)};
const setPic=d=>{pic=d;$('pic-img').src=d;$('pic-img').style.display='block'};
$('file-pic').onchange=async e=>{let f=e.target.files[0];e.target.value='';if(!f)return;try{let b=await createImageBitmap(f),k=Math.min(1,512/Math.max(b.width,b.height)),c=document.createElement('canvas');c.width=Math.round(b.width*k);c.height=Math.round(b.height*k);c.getContext('2d').drawImage(b,0,0,c.width,c.height);setPic(c.toDataURL('image/jpeg',.85))}catch{let R=new FileReader();R.onload=x=>setPic(x.target.result);R.readAsDataURL(f)}};
const rs=()=>{ed=0;$('g-em').style.display=$('g-pw').style.display='';$('h4').textContent="CREATE A WISHING ACCOUNT FIRST";$('b-del').style.display='none';$('acc-terms').checked=false;};
const back4=()=>{let e=ed;rs();go(e?5:3)};
const edit=()=>{ed=1;$('g-em').style.display=$('g-pw').style.display='none';$('acc-name').value=acc.name;$('acc-country').value=acc.country;$('acc-age').value=acc.age;$('acc-gender').value=acc.gender;pic=acc.pic||"";$('pic-img').style.display=pic?'block':'none';if(pic)$('pic-img').src=pic;$('h4').textContent="EDIT YOUR WISHING ACCOUNT";$('b-del').style.display='block';$('acc-terms').checked=true;go(4)};
const save=async()=>{let g=k=>$(k).value.trim(),a={name:g('acc-name'),country:g('acc-country'),age:g('acc-age'),gender:$('acc-gender').value};if(!a.name||!a.country||!a.age||!a.gender)return alert("Please fill in all fields.");if(!pic)return alert("Please upload a profile picture.");if(!$('acc-terms').checked)return alert("You must agree to the Terms & Conditions.");try{let u=await W.user();if(!u){let em=g('acc-email'),p2=$('acc-pass').value;if(!em||p2.length<6)return alert("Enter your email and a password of at least 6 characters.");await W.signUp(em,p2);u=await W.user();if(!u)return alert("Could not log you in. If you already have an account use Log in, or confirm your email first.")}let f=pic.startsWith('data:')?await (await fetch(pic)).blob():null;let p=await W.saveProfile({...a,pic_url:acc&&acc.pic},f);acc=ap(p);rs();render();if(pw)await fin();else go(5)}catch(e){alert(e.message)}};
const delAcc=()=>ask("This permanently deletes your account and wishes. Type DELETE to confirm.",1,async()=>{try{await W.deleteAccount()}catch(e){return alert(e.message)}acc=null;pic="";ws=[];rx={};pw=null;ew=0;tabi=0;draw();clr();rs();['acc-name','acc-country','acc-age','acc-gender','acc-email','acc-pass'].forEach(k=>$(k).value="");$('pic-img').style.display='none';$('h-pic').style.display='none';$('h-pic').removeAttribute('src');$('h-name').textContent='';go(1)},'Delete');

const HI='<svg viewBox="0 0 24 24"><path d="M12 20.5C5 15.5 3 12 3 9a4.5 4.5 0 0 1 9-1.5A4.5 4.5 0 0 1 21 9c0 3-2 6.5-9 11.5z"/></svg>',CI='<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',BI='<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>',CA='<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',PL='<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="#fff"/></svg>',PA='<svg viewBox="0 0 24 24"><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" fill="#fff"/></svg>',fm=s=>Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0"),dt=ts=>new Date(ts).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}),meL=x=>x===acc.uid,meC=c=>!c.u||c.u===acc.uid;
const av=(el,o)=>{el.innerHTML='';if(o&&o.pic){let m=new Image();m.decoding='async';m.src=o.pic;el.append(m)}else el.textContent=((o&&o.name)||'?')[0].toUpperCase()};
const upd=e=>{let r=rx[e.w.id];if(!r)return;let a=e.querySelectorAll('.ic');if(a.length<4)return;a[0].classList.toggle('on',r.lk.some(meL));a[0].lastChild.textContent=r.lk.length||'';a[1].lastChild.textContent=r.cm.length||'';a[2].classList.toggle('on',sv().ids.includes(e.w.id))};
const ct=e=>e.querySelectorAll('.bx').forEach(b=>{let m=b.firstChild,n=m.children.length;b.lastChild.textContent=n>1?`${Math.round(m.scrollLeft/(m.clientWidth||1))+1}/${n}`:''});
const play=e=>{if(!e)return;let g=e.querySelector('.bgl video');if(g){if(e.a&&!vo){pauseAll(g);playSafe(g)}else try{g.pause()}catch{}}let m=e.querySelector('.vb .mc');if(!m)return;let k=Math.round(m.scrollLeft/(m.clientWidth||1)),on=e.a&&!vo;[...m.children].forEach((c,j)=>{let v=c.firstChild;if(!v)return;if(on&&j==k){if(!v.p){v.p=1}v.muted=false;pauseAll(v);try{let p=v.play();if(p&&p.catch)p.catch(()=>{})}catch{}}else{v.p=0;try{v.pause()}catch{};if(on && j!==k) {try{v.currentTime=0}catch{}}}})};
const rv=u=>typeof u==="string"&&u.startsWith('blob:')&&URL.revokeObjectURL(u),isV=b=>b.file?b.file.type.startsWith('video'):(b.type?b.type.startsWith('video'):/\.(mp4|webm|mov|m4v)(\?|$)/i.test(b.url||'')),bu2=b=>b.file?blobUrl(b.file):b.url;
const rmBg=e=>{if(!e)return;let o=e.querySelector('.bgl');if(o){o.querySelectorAll('[data-u]').forEach(m=>rv(m.dataset.u));o.remove()}e.classList.remove('hb')};
const setBg=e=>{rmBg(e);if(!e||!e.w)return;let rec=rx[e.w.id];if(!rec)return;let b=bgs.find(x=>x.id==rec.bg);if(!b||!e.m)return;let d=document.createElement('div');d.className='bgl';if(b.css){d.style.background=b.css}else{let u=bu2(b),v=isV(b),m=document.createElement(v?'video':'img');m.dataset.u=u;if(v){m.muted=m.playsInline=true;m.controls=false;m.disablePictureInPicture=true;m.preload='metadata'}m.src=u;d.append(m)}e.prepend(d);e.classList.add('hb');play(e)};

function card(w){let o=w.owner||acc,e=document.createElement('section');e.className='wi';e.w=w;e.sound=true;rx[w.id]=rx[w.id]||{id:w.id,lk:[],cm:[]};e.innerHTML=`<div class="lc"><button class="ic" data-a="lk">${HI}<i></i></button><button class="ic" data-a="cm">${CI}<i></i></button><button class="ic" data-a="sv">${BI}<i></i></button><button class="ic" data-a="call">${CA}<i></i></button><div class="tx" data-a="tx"><h4></h4><p></p><span class="rd"></span></div></div><div class="rc"><div class="pf"><div class="rw"><div class="rg"></div><i class="od"></i></div><button class="mre" data-a="mr">More</button></div><div class="bx pb"><div class="mc"></div><em class="ct"></em></div><div class="bx vb"><div class="mc"></div><em class="ct"></em></div></div>`;e.querySelector('h4').textContent=w.title;e.querySelector('p').textContent=w.text;av(e.querySelector('.rg'),o);e.querySelector('.od').hidden=!!(w.owner&&!w.owner.online);e.querySelector('.pb').hidden=!(w.files||[]).some(f=>f.type.startsWith('image'));e.querySelector('.vb').hidden=!(w.files||[]).some(f=>f.type.startsWith('video'));if(!(w.files||[]).length){e.classList.add('nm');e.querySelector('.rc').append(e.querySelector('.tx'))}e.querySelectorAll('.mc').forEach(m=>{m.onscroll=()=>{ct(e);clearTimeout(m.t);m.t=setTimeout(()=>play(e),100);[...m.children].forEach((c,j)=>{let v=c.firstChild;if(v&&v.pause&&j!==Math.round(m.scrollLeft/(m.clientWidth||1))){try{v.pause()}catch{};try{v.currentTime=0}catch{}}})}});upd(e);return e}
function mount(e){
  if(e.m) return;
  if(e.querySelector('.mi')) { e.m=1; return; }
  e.m=1;
  (e.w.files||[]).forEach(f=>{let v=f.type.startsWith('video'),u=blobUrl(f),m=document.createElement(v?'video':'img'),c=document.createElement('div');c.className='mi';c.f=f;m.dataset.u=u;if(v){m.playsInline=true;m.muted=false;m.preload='metadata'}else m.decoding='async';m.src=u;c.append(m);e.querySelector(v?'.vb .mc':'.pb .mc').append(c)});
  setBg(e);ct(e);play(e)
}
function unmount(e){if(!e.m)return;e.m=0;rmBg(e);e.querySelectorAll('.mc').forEach(mc=>{mc.querySelectorAll('video').forEach(v=>{try{v.pause()}catch{}})});e.classList.remove('hb')}
const io1=new IntersectionObserver(es=>es.forEach(x=>x.isIntersecting?mount(x.target):unmount(x.target)),{root:fd,rootMargin:'300% 0px'}),io2=new IntersectionObserver(es=>es.forEach(x=>{x.target.a=x.isIntersecting;play(x.target)}),{root:fd,threshold:.6});
function buildFeed(list){io1.disconnect();io2.disconnect();let l=(list||[]).map(card);if(!l.length)fd.innerHTML='<div class="em">No wishes yet.</div>';else{fd.replaceChildren(...l);l.forEach(e=>{io1.observe(e);io2.observe(e)})}}
let searchReturnToScroll=false;
const openFeed=async(list,start,fromSearch=false)=>{searchReturnToScroll=fromSearch;let s6=$('s6');if(s6){s6.classList.remove('wp');s6.classList.toggle('search-results-view',fromSearch)}wcur=null;if(!list){try{list=(await W.feed()).map(adapt)}catch(e){console.error(e);list=[]}}try{await hydrate(list)}catch(e){}buildFeed(list);go(6);fd.scrollTop=0;if(start){let el=[...fd.children].find(x=>x.w&&x.w.id==start);if(el)fd.scrollTop=el.offsetTop}};
const backFeed=()=>{if(searchReturnToScroll)go(9);else go(5)};
document.onvisibilitychange=()=>document.hidden?fd.querySelectorAll('video').forEach(v=>{try{v.pause()}catch{}}):fd.querySelectorAll('.wi').forEach(play);

fd.onclick=e=>{
  let p=e.target.closest('.wi');if(!p)return;
  let a=e.target.closest('[data-a]');
  if(!a){let m=e.target.closest('.mi');if(m)vopen(p.w.files,p.w.files.indexOf(m.f));return}
  let k=a.dataset.a,r=rx[p.w.id];if(!r)return;
  if(k=='lk'){let was=r.lk.some(meL);r.lk=was?r.lk.filter(x=>!meL(x)):[...r.lk,acc.uid];upd(p);W.toggleLike(p.w.id,was).catch(()=>toast('Could not save like'))}
  else if(k=='cm'){cw=p;r.cm.some(meC)?openCm():$('sp').classList.add('sh')}
  else if(k=='sv')tgS(p.w.id);
  else if(k=='call'){callWish(p.w)}
  else if(k=='mr'){let o=p.w.owner||acc;$('m-name').textContent=o.name;$('m-age').textContent=o.age;$('m-gen').textContent=o.gender;$('m-cty').textContent=o.country;$('ms').classList.add('sh')}
  else if(!p.classList.contains('nm'))a.classList.toggle('op')
};

const openWish=id=>{let w=(ws||[]).find(x=>x.id==id);if(!w)return;searchReturnToScroll=false;wcur=w;let s6=$('s6');if(s6)s6.classList.add('wp');let wt=$('wt6');if(wt)wt.textContent=w.title;rx[w.id]=rx[w.id]||{id:w.id,lk:[],cm:[]};buildFeed([w]);renderBgs();go(6);fd.scrollTop=0};
function renderBgs(){bu.forEach(rv);bu=[];let r=wcur?rx[wcur.id]:null,f=document.createDocumentFragment();bgs.forEach(b=>{let c=document.createElement('div'),own=!b.price||bt().ids.includes(b.id),on=!!r&&r.bg==b.id;c.className='bc'+(on?' on':'');c.dataset.id=b.id;c.innerHTML='<div class="bt"></div><div class="bn"></div><div class="bp"></div>';let m=document.createElement('div');m.style.width='100%';m.style.height='100%';m.style.background=b.css||'#fff';c.firstChild.append(m);c.querySelector('.bn').textContent=b.name;c.querySelector('.bp').textContent=on?'APPLIED':!b.price?'FREE':own?'OWNED':'$'+b.price.toFixed(2);f.append(c)});$('br').replaceChildren(f)}
const useBg=id=>{if(!wcur)return;let bb=bgs.find(x=>x.id==id);if(bb&&bb.price&&!bt().ids.includes(id))return ask("Buy the Blue background for 2$? It is yours forever.",0,()=>payFor('background',{background:'blue'},()=>{bt().ids.push('bg-blue');renderBgs();useBg(id)}),'Pay');let r=rx[wcur.id];if(!r)return;r.bg=r.bg==id?null:id;W.setBackground(wcur.id,r.bg==='bg-blue'?'blue':'white').catch(()=>{});let el=fd.querySelector('.wi');if(el)setBg(el);renderBgs()};
$('br').onclick=e=>{let c=e.target.closest('.bc');if(!c)return;let b=bgs.find(x=>x.id==c.dataset.id);if(!b)return;useBg(b.id)};

const grow=()=>{let c=$('ci');c.style.height='auto';c.style.height=Math.min(c.scrollHeight,110)+'px'};
function cmMediaHTML(list,idx){if(!list||!list.length)return'';return'<div class="cm-media">'+list.map((m,mi)=>{let v=m.type==='video',a=m.type==='audio';return`<div class="mm ${v||a?'v':''}" data-mi="${mi}" data-i="${idx}">${v?`<video src="${m.url}" playsinline preload="metadata"></video>`:a?`<div style="width:100%;height:100%;display:flex;justify-content:center;align-items:center;color:#fff;font-size:1.1rem">♪</div>`:`<img src="${m.url}">`}</div>`}).join('')+'</div>'}
const drawCm=()=>{let r=rx[cw.w.id];if(!r)return;let mine=r.cm.find(meC),f=document.createDocumentFragment();[...r.cm].sort((a,b)=>meC(b)-meC(a)||(b.ts||0)-(a.ts||0)).forEach((c,idx)=>{let m=meC(c),o=m?acc:{name:c.n,pic:c.p},d=document.createElement('div');d.className='ci'+(m?' me':'');d.innerHTML='<div class="av2"></div><div class="cc"><p><b></b> <span></span></p><small class="dt"></small></div>';av(d.firstChild,o);d.querySelector('b').textContent=o.name+(c.s?' supports :':" doesn't support :");d.querySelector('span').textContent=c.t;d.querySelector('.dt').textContent=c.ts?dt(c.ts):'';if(c.media&&c.media.length)d.querySelector('.cc').insertAdjacentHTML('beforeend',cmMediaHTML(c.media,idx));if(m){let a=document.createElement('div');a.className='ca';a.innerHTML=`<b onclick="edCm()">${ec?'Cancel':'Edit'}</b><b class="d" onclick="delCm()">Delete</b>`;d.querySelector('.cc').append(a)}f.append(d)});$('cl').replaceChildren(f);if(!r.cm.length)$('cl').innerHTML='<div class="em">No comments yet.</div>';$('cb').hidden=!!mine&&!ec;$('cl').scrollTop=0};
$('cl').onclick=e=>{let mm=e.target.closest('.mm');if(!mm)return;let idx=+mm.dataset.i,mi=+mm.dataset.mi;let r=rx[cw.w.id];if(!r)return;let sorted=[...r.cm].sort((a,b)=>meC(b)-meC(a)||(b.ts||0)-(a.ts||0));let c=sorted[idx];if(!c||!c.media)return;openMedia(c.media,mi)};
const openCm=async()=>{$('sp').classList.remove('sh');ec=0;cmMediaList=[];$('cpv').innerHTML='';$('cpv').classList.remove('sh');$('pt').textContent=cw.w.title;try{rx[cw.w.id].cm=(await W.comments(cw.w.id)).map(adaptC)}catch(e){}drawCm();$('cm').classList.add('sh')};
const cmx=()=>{ec=0;$('ci').value='';$('ci').placeholder='Comment';grow();$('ci').blur();cmMediaList=[];$('cpv').innerHTML='';$('cpv').classList.remove('sh');$('cm').classList.remove('sh');upd(cw)};
const edCm=()=>{
  ec=!ec;
  let comment = rx[cw.w.id].cm.find(meC);
  if(ec && comment) {
    $('ci').value = comment.t;
    cmMediaList = [...(comment.media || [])];
    let pv=$('cpv');
    pv.innerHTML=cmMediaList.map((m,mi)=>m.type==='video'?`<div class="pv"><video src="${m.url}" muted style="width:100%;height:100%;object-fit:cover"></video><button onclick="rmCmMedia(${mi})">x</button></div>`:m.type==='audio'?`<div class="pv"><div style="width:100%;height:100%;display:flex;justify-content:center;align-items:center;background:#0000a0;color:#fff;font-size:.7rem">♪</div><button onclick="rmCmMedia(${mi})">x</button></div>`:`<div class="pv"><img src="${m.url}" style="width:100%;height:100%;object-fit:cover"><button onclick="rmCmMedia(${mi})">x</button></div>`).join('');
    if(cmMediaList.length) pv.classList.add('sh'); else pv.classList.remove('sh');
  } else {
    $('ci').value = '';
    cmMediaList = [];
    $('cpv').innerHTML='';
    $('cpv').classList.remove('sh');
  }
  $('ci').placeholder=ec?'Edit comment':'Comment';
  grow();drawCm();if(ec)$('ci').focus();
};
const delCm=()=>ask("Delete your comment?",0,async()=>{let r=rx[cw.w.id];if(!r)return;let m=r.cm.find(meC);if(!m)return;try{await W.deleteComment(m.id)}catch(e){return alert(e.message)}r.cm=r.cm.filter(c=>!meC(c));cmx()});
let sending=0;const send=async()=>{if(sending)return;sending=1;try{await send0()}finally{sending=0}};const send0=async()=>{let v=$('ci').value.trim();if(!v&&!cmMediaList.length)return;let r=rx[cw.w.id];if(!r)return;let m=r.cm.find(meC);try{let media=[];for(const x of cmMediaList)media.push(x.url.startsWith('data:')?await W.upload(await (await fetch(x.url)).blob(),acc.uid):x);if(m){if(!ec)return;await W.editComment(m.id,{body:v,media})}else await W.addComment(cw.w.id,{supports:!!sup,body:v,media});r.cm=(await W.comments(cw.w.id)).map(adaptC)}catch(e){return alert(e.message)}ec=0;cmMediaList=[];$('cpv').innerHTML='';$('cpv').classList.remove('sh');$('ci').value='';$('ci').placeholder='Comment';grow();drawCm()};
$('file-cm').onchange=e=>{
  let files=photoVideoFiles(e.target.files); e.target.value='';
  if(!files.length) return;
  let curV=cmMediaList.filter(m=>m.type==='video').length, curI=cmMediaList.filter(m=>m.type==='image').length;
  for(let f of files) {
    let isV=f.type.startsWith('video'), isI=f.type.startsWith('image');
    if(isV) { if(curV>=1) { toast("Max 1 video allowed."); continue; } curV++; }
    else if(isI) { if(curI>=1) { toast("Max 1 photo allowed."); continue; } curI++; }
    
    let r=new FileReader();
    r.onload=x=>{
      cmMediaList.push({url:x.target.result,type:isV?'video':f.type.startsWith('audio')?'audio':'image'});
      let pv=$('cpv');pv.innerHTML=cmMediaList.map((m,mi)=>m.type==='video'?`<div class="pv"><video src="${m.url}" muted style="width:100%;height:100%;object-fit:cover"></video><button onclick="rmCmMedia(${mi})">x</button></div>`:m.type==='audio'?`<div class="pv"><div style="width:100%;height:100%;display:flex;justify-content:center;align-items:center;background:#0000a0;color:#fff;font-size:.7rem">♪</div><button onclick="rmCmMedia(${mi})">x</button></div>`:`<div class="pv"><img src="${m.url}" style="width:100%;height:100%;object-fit:cover"><button onclick="rmCmMedia(${mi})">x</button></div>`).join('');
      pv.classList.add('sh');
    };
    r.readAsDataURL(f);
  }
};
const rmCmMedia=mi=>{cmMediaList.splice(mi,1);let pv=$('cpv');pv.innerHTML=cmMediaList.map((m,j)=>m.type==='video'?`<div class="pv"><video src="${m.url}" muted style="width:100%;height:100%;object-fit:cover"></video><button onclick="rmCmMedia(${j})">x</button></div>`:m.type==='audio'?`<div class="pv"><div style="width:100%;height:100%;display:flex;justify-content:center;align-items:center;background:#0000a0;color:#fff;font-size:.7rem">♪</div><button onclick="rmCmMedia(${j})">x</button></div>`:`<div class="pv"><img src="${m.url}" style="width:100%;height:100%;object-fit:cover"><button onclick="rmCmMedia(${j})">x</button></div>`).join('');if(!cmMediaList.length)pv.classList.remove('sh')};
$('sy').onclick=()=>{sup=1;openCm()};$('sn').onclick=()=>{sup=0;openCm()};$('ci').oninput=grow;$('ci').onkeydown=e=>e.key==="Enter"&&!e.shiftKey&&!matchMedia('(pointer:coarse)').matches&&(e.preventDefault(),send());

const reportChat=async b=>{if(!curChat||curChat.role!=='wisher')return;try{await W.report(curChat.w.id);b.setAttribute('aria-pressed','true');toast('Report sent')}catch(e){toast(/duplicate/.test(e.message)?'You already reported this':'You can report only after you both have chatted')}};


const sendChat=async()=>{if(!curChat||chSending)return;let v=$('ch-txt').value.trim();if(!v&&!chMediaList.length)return;chSending=1;try{let media=[];for(const x of chMediaList)media.push(x.url.startsWith('data:')?await W.upload(await (await fetch(x.url)).blob(),acc.uid):x);if(curChat.edit>=0){await W.editMsg(curChat.msgs[curChat.edit].id,v,media);curChat.edit=-1}else await W.sendMsg(curChat.w.id,v,media);$('ch-txt').value='';chMediaList=[];pvChat();curChat.msgs=await W.messages(curChat.w.id);drawChat()}catch(e){alert(e.message)}chSending=0};

const editChatMsg=idx=>{let m=curChat&&curChat.msgs[idx];if(!m||m.sender_id!==acc.uid)return;curChat.edit=idx;$('ch-txt').value=m.body||'';chMediaList=[...(m.media||[])];pvChat();$('ch-txt').focus()};

const delChatMsg=async idx=>{let m=curChat&&curChat.msgs[idx];if(!m||m.sender_id!==acc.uid)return;try{await W.delMsg(m.id);curChat.msgs.splice(idx,1);drawChat()}catch(e){alert(e.message)}};

$('file-chat').onchange = e => {
  let files = photoVideoFiles(e.target.files); e.target.value = '';
  if(!files.length) return;
  let curV = chMediaList.filter(m=>m.type==='video').length, curI = chMediaList.filter(m=>m.type==='image').length;
  for(let f of files) {
    let isV = f.type.startsWith('video'), isI = f.type.startsWith('image');
    if(isV) { if(curV>=1) { toast("Max 1 video allowed."); continue; } curV++; }
    else if(isI) { if(curI>=1) { toast("Max 1 photo allowed."); continue; } curI++; }
    
    let r = new FileReader();
    r.onload=x=>{chMediaList.push({url:x.target.result,type:isV?'video':'image'});pvChat()};
    r.readAsDataURL(f);
  }
};
const rmChatMedia=mi=>{chMediaList.splice(mi,1);pvChat()};

/* === SEARCH LOGIC === */
const openSearch = () => {
  go(9);
  $('se-in').value = '';
  $('se-default-area').style.display = 'block';
  $('se-list').innerHTML = '';
  setTimeout(() => $('se-in').focus(), 300);
};
$('search-open').addEventListener('click', openSearch);

$('se-in').oninput = () => {
  clearTimeout(searchTimeout);
  let q = $('se-in').value.trim();
  if(!q) {
    $('se-default-area').style.display = 'block';
    $('se-list').innerHTML = '';
    return;
  }
  $('se-default-area').style.display = 'none';
  $('se-list').innerHTML = '<div class="load-dots"><span></span><span></span><span></span></div>';
  searchTimeout = setTimeout(() => {
    renderSearch(q);
  }, 600);
};

async function renderSearch(q){if(!q)return;let results=[];try{results=(await W.search(q)).map(adapt);await hydrate(results)}catch(e){console.error(e)}

  if(!results.length) {
    $('se-list').innerHTML = '<div class="se-empty">No wishes found.</div>';
    return;
  }

  $('se-list').innerHTML = '';
  let grid = document.createElement('div');
  grid.className = 'se-results';
  results.forEach(w => {
    let d = document.createElement('div');
    d.className = 'se-item';
    d.setAttribute('role','button');
    d.setAttribute('tabindex','0');
    d.onclick = () => openFeed(results, w.id, true);
    d.onkeydown = e => { if(e.key==='Enter'||e.key===' '){e.preventDefault();openFeed(results,w.id,true)} };
    let file = (w.files || []).find(f => f.type.startsWith('video') || f.type.startsWith('image'));
    let media = document.createElement('div');
    media.className = 'se-thumb';
    if(file) {
      let isVideo = file.type.startsWith('video');
      let preview = document.createElement(isVideo?'video':'img');
      preview.src = blobUrl(file);
      if(isVideo){preview.muted=true;preview.loop=true;preview.playsInline=true;preview.autoplay=true;preview.preload='metadata'}
      else preview.decoding='async';
      media.append(preview);
    } else {
      let avatar = document.createElement('div');
      avatar.className = 'av';
      if(w.owner&&w.owner.pic){let img=document.createElement('img');img.src=w.owner.pic;img.alt='';avatar.append(img)}
      media.append(avatar);
    }
    let title = document.createElement('div');
    title.className = 'ttl';
    title.textContent = w.title || 'Untitled wish';
    d.append(media,title);
    grid.append(d);
  });
  $('se-list').append(grid);
}

// POSITION DOUBLE TAP LOGIC
let lastTap = 0;
$('s9').addEventListener('touchend', function(e) {
  const currentTime = new Date().getTime();
  const tapLength = currentTime - lastTap;
  if (tapLength < 300 && tapLength > 0) {
    e.preventDefault(); 
    showPos();
  }
  lastTap = currentTime;
});

/* === FULLSCREEN VIEWER === */
let vk=0,vn=0,vu=[],cv=null,tm,tc=0,pd=0,zs=1,zx=0,zy=0,d0=0,s0=1,p0={x:0,y:0},seekT=0,seekV=0;
const B=$('vbody'),flash=(h,c)=>{let f=$('fl');f.className='';f.innerHTML=h;void f.offsetWidth;f.className='go '+(c||'')},tick=m=>{let d=m.duration||0;$('pgi').style.width=d?m.currentTime/d*100+'%':'0';$('vt').textContent=fm(m.currentTime)+" / "+fm(d)},zel=()=>{let s=B.children[vk];return s&&s.firstChild},zap=()=>{let m=zel();if(!m)return;let lx=(zs-1)*innerWidth/2,ly=(zs-1)*innerHeight/2;zx=Math.max(-lx,Math.min(lx,zx));zy=Math.max(-ly,Math.min(ly,zy));m.style.transform=`translate(${zx}px,${zy}px) scale(${zs})`},zr=()=>{let m=zel();zs=1;zx=zy=0;if(m){m.style.transition='transform .25s';zap();setTimeout(()=>m.style.transition='',260)}},dist=t=>Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);

function buildSlides(items,start){
  B.innerHTML='';vu=[];vn=items.length;zs=1;zx=zy=0;
  items.forEach(f=>{
    let isBlob=f instanceof Blob;
    let isV2=isBlob?f.type.startsWith('video'):f.type==='video';
    let isA=isBlob?f.type.startsWith('audio'):f.type==='audio';
    let u=isBlob?blobUrl(f):f.url;vu.push(isBlob?u:null);
    let m=document.createElement(isV2?'video':isA?'audio':'img'),s=document.createElement('div');
    s.className='vs';s.dataset.url=u;
    if(isV2||isA){
      m.playsInline=true;if(isV2)m.loop=true;
      m.preload='metadata';
      m.dataset.src=u;
      m.ontimeupdate=()=>m===cv&&tick(m);
    }else{m.decoding='async';m.src=u}
    s.append(m);B.append(s);
  });
  vo=1;pauseAll(null);$('vw').classList.add('sh');
  B.scrollLeft=start*B.clientWidth;vk=-1;vsel(start);
}
function openMedia(list,idx){ let items=list.map(m=>m.file?m.file:{url:m.url,type:m.type}); buildSlides(items,idx); }
function vopen(fs,k){ buildSlides((fs||[]).map(f=>f),k); }

function vsel(k){
  let pk=vk;vk=k;cv=null;zs=1;zx=zy=0;
  [...B.children].forEach((s,j)=>{
    let m=s.firstChild;m.style.transform='';
    if(!m)return;
    if(m.pause){
      if(j==k){
        let src=m.dataset.src||m.currentSrc||m.src;
        if(!m.getAttribute('src')){m.setAttribute('src',src)}
        m.preload='auto';
        cv=m;
        if(pk!==k){try{m.currentTime=0}catch{}}
        pauseAll(m);m.muted=false;playSafe(m);
      } else {
        try{m.pause()}catch{}
        try{m.currentTime=0}catch{}
        if(Math.abs(j-k)>1){
          m.preload='none';
          m.removeAttribute('src');
          try{m.load()}catch{}
        } else {
          m.preload='metadata';
        }
      }
    }
  });
  $('vn').textContent=vn>1?`${k+1}/${vn}`:'';
  $('vw').classList.toggle('isv',!!cv);
  if(cv)tick(cv);
}
B.onscroll=()=>{clearTimeout(B.t);B.t=setTimeout(()=>{let k=Math.round(B.scrollLeft/(B.clientWidth||1));k!==vk&&vsel(k)},90)};
const one=s=>{if(cv&&s.firstChild===cv)cv.paused?(playSafe(cv),flash(PL)):(cv.pause(),flash(PA))};
B.onclick=e=>{let s=e.target.closest('.vs');if(!s)return;tc++;clearTimeout(tm);tm=setTimeout(()=>{let c=tc;tc=0;if(c==1){one(s)}},280)};
B.addEventListener('touchstart',e=>{if(e.touches.length==2){d0=dist(e.touches);s0=zs;e.preventDefault()}else if(e.touches.length==1)p0={x:e.touches[0].clientX-zx,y:e.touches[0].clientY-zy}},{passive:false});
B.addEventListener('touchmove',e=>{if(e.touches.length==2){e.preventDefault();zs=Math.min(5,Math.max(1,s0*dist(e.touches)/d0));zap()}else if(zs>1&&e.touches.length==1){e.preventDefault();zx=e.touches[0].clientX-p0.x;zy=e.touches[0].clientY-p0.y;zap()}},{passive:false});
B.addEventListener('touchend',e=>{if(e.touches.length==0){if(zs<1.08&&zs!=1)zr()}else if(e.touches.length==1)p0={x:e.touches[0].clientX-zx,y:e.touches[0].clientY-zy}});
const sk=e=>{if(!cv||!cv.duration)return;let r=$('pg').getBoundingClientRect();let t=cv.duration*Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));$('pgi').style.width=(t/cv.duration*100)+'%';seekV=t;let now=performance.now();if(now-seekT>80){seekT=now;try{cv.currentTime=t}catch{}}};
$('pg').onpointerdown=e=>{$('pg').setPointerCapture(e.pointerId);pd=1;sk(e)};
$('pg').onpointermove=e=>{if(!pd)return;sk(e)};
$('pg').onpointerup=$('pg').onpointercancel=()=>{if(pd&&cv){try{cv.currentTime=seekV}catch{}}pd=0};
const vclose=()=>{$('vw').classList.remove('sh');clearTimeout(tm);tc=0;B.querySelectorAll('video,audio').forEach(m=>{m.ontimeupdate=null;try{m.pause()}catch{};m.removeAttribute('src');try{m.load()}catch{}});B.innerHTML='';cv=null;vo=0;zs=1;zx=zy=0;fd.querySelectorAll('.wi').forEach(e=>{upd(e);play(e)})};

let ig=0;addEventListener('pointerdown',e=>{let a=document.activeElement,b=e.target.closest('.back,.vq,.mo');if(!b||!a||!/^(INPUT|TEXTAREA)$/.test(a.tagName)||e.target.closest('input,textarea'))return;if(b.classList.contains('mo')&&e.target!==b)return;a.blur();ig=Date.now();b.click()},true);addEventListener('click',e=>{if(ig&&e.isTrusted&&Date.now()-ig<700){e.stopPropagation();e.preventDefault();ig=0}},true);

/* === SUPABASE CONNECTION === */
const ap=p=>p&&{uid:p.id,name:p.name,country:p.country,age:p.age,gender:p.gender,pic:p.pic_url};
const adapt=w=>{let o=w.owner||{};let x={id:w.id,granter_id:w.granter_id,done:w.done,doneAt:Date.parse(w.done_changed_at),title:w.title,text:w.body,ts:Date.parse(w.created_at),files:(w.media||[]).map(m=>({url:m.url,type:m.type})),owner:{uid:o.id,name:o.name,country:o.country,age:o.age,gender:o.gender,pic:o.pic_url,online:W.isOnline(o)}};wc[w.id]=x;rx[w.id]=rx[w.id]||{id:w.id,lk:[],cm:[]};rx[w.id].bg=w.background==='blue'?'bg-blue':null;return x};
const adaptC=c=>({id:c.id,u:c.user_id,n:c.author&&c.author.name,p:c.author&&c.author.pic_url,s:c.supports,t:c.body,media:c.media||[],ts:Date.parse(c.created_at)});
async function hydrate(list){let ids=list.map(w=>w.id);if(!ids.length)return;let [L,C]=await Promise.all([W.likesFor(ids),W.commentsFor(ids)]);ids.forEach(id=>{let r=rx[id];r.lk=L.filter(l=>l.wish_id==id).map(l=>l.user_id);r.cm=C.filter(c=>c.wish_id==id).map(adaptC)})}
async function loadMine(){ws=(await W.myWishes()).map(adapt);try{await hydrate(ws)}catch(e){}draw();paintBadges()}
async function loadSaves(){let r=await W.mySaves();sv().ids=r.map(x=>x.wish_id);r.forEach(x=>x.wish&&adapt(x.wish))}
async function boot(){loadPins();try{let u=await W.user();if(u){let p=await W.myProfile();if(p){acc=ap(p);render();await loadMine();try{await loadSaves()}catch(e){}try{W.sb.channel("nt").on("postgres_changes",{event:"INSERT",schema:"public",table:"notifications",filter:"user_id=eq."+acc.uid},()=>{$("s5").classList.contains("on")?checkNotifs():toast("You have a new notification")}).subscribe()}catch(e){}try{(await W.ownedBgs()).forEach(b=>{let i=b==='blue'?'bg-blue':b;if(!bt().ids.includes(i))bt().ids.push(i)})}catch(e){}drawSv();await openFeed();return}}}catch(e){console.error(e);go(1);toast('Could not open your account: '+(e.message||e));return}go(1)}
async function doLogin(){try{await W.signIn($('li-em').value.trim(),$('li-pw').value);await boot()}catch(e){alert(e.message)}}
/* === CHAT (wisher + granter) === */
let curChat=null,chSending=0,lastT=0,typT,chPoll=0;
function esc(x){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function pvChat(){let pv=$('ch-pv');pv.innerHTML=chMediaList.map((m,i)=>`<div class="pv">${m.type==='video'?`<video src="${m.url}" muted style="width:100%;height:100%;object-fit:cover"></video>`:`<img src="${m.url}" style="width:100%;height:100%;object-fit:cover">`}<button onclick="rmChatMedia(${i})">x</button></div>`).join('');pv.classList.toggle('sh',chMediaList.length>0)}
async function paintBadges(){try{let a=await W.unread(),c={};a.forEach(x=>c[x.wish_id]=(c[x.wish_id]||0)+1);document.querySelectorAll('#wl .wr').forEach(r=>{let n=c[r.dataset.id]||0,b=r.querySelector('.w-badge');if(b)b.textContent=n+(n==1?' message':' messages')})}catch(e){}}
async function callWish(w){try{
  if(w.owner&&w.owner.uid===acc.uid)return openChat(w,'wisher');
  w.granter_id=await W.wishGranter(w.id);let g=await W.myGranter();gAcc=g;
  if(w.granter_id===acc.uid)return openChat(w,'granter');
  if(g&&g.frozen)return toast('Your account has been frozen due to frequent reports of scam and fraud. ⚠️');
  if(w.granter_id)return toast('Sorry, this wish has a Granter. Please check another wish.');
  pendingW=w;if(!g){resetG();go(11)}else go(12)
}catch(e){alert(e.message)}}
async function openChat(w,role){try{
  if(chPoll){clearInterval(chPoll);chPoll=0}
  let search=role==='wisher'&&!w.granter_id,oid=role==='wisher'?w.granter_id:w.owner.uid,o=search?{}:((role==='wisher'?await W.granterInfo(oid):await W.profileInfo(oid))||{});
  curChat={w,role,other:o,msgs:search?[]:await W.messages(w.id),edit:-1};
  $('ch-flag').style.visibility=role==='wisher'&&!search?'visible':'hidden';$('ch-flag').setAttribute('aria-pressed','false');$('ch-typing').textContent='';
  document.querySelector('.ch-more').innerHTML=(search?'<div class="shimmer"></div>':'')+'MORE';
  if(search)$('ch-av').innerHTML='<div class="shimmer"></div>';else{av($('ch-av'),{pic:o.pic_url,name:o.name});let im=$('ch-av').querySelector('img');if(im)im.style.cssText='width:100%;height:100%;object-fit:cover'}
  $('ch-txt').disabled=search;$('ch-txt').placeholder=search?'Searching for a granter . . .':role==='wisher'?'Chat with granter . . .':'Chat with wisher . . .';chMediaList=[];pvChat();
  go(8);drawChat();
  if(search){$('ch-list').innerHTML='<div class="em">Searching for a granter . . .</div>';chPoll=setInterval(async()=>{try{let g=await W.wishGranter(w.id);if(g){clearInterval(chPoll);chPoll=0;w.granter_id=g;openChat(w,'wisher')}}catch(e){}},8000);return}
  W.markRead(w.id);
  curChat.ch=W.subscribe(w.id,async()=>{if(!curChat)return;curChat.msgs=await W.messages(w.id);drawChat();W.markRead(w.id)},uid=>{if(uid===acc.uid)return;$('ch-typing').textContent='Typing . . .';clearTimeout(typT);typT=setTimeout(()=>$('ch-typing').textContent='',3000)})
}catch(e){alert(e.message)}}
function chatMore(){let o=curChat&&curChat.other;if(!o||!o.name)return;$('m-name').textContent=o.name||'';$('m-age').textContent=o.age||'';$('m-gen').textContent=o.gender||'';$('m-cty').textContent=o.country||'';$('ms').classList.add('sh')}
function backFromChat(){if(curChat&&curChat.role==='granter'){$('gb').classList.add('sh');return}leaveChat()}
function leaveChat(){if(chPoll){clearInterval(chPoll);chPoll=0}if(curChat&&curChat.ch)W.unsub(curChat.ch);curChat=null;go(6);if(wcur)setTimeout(()=>{let el=[...fd.children].find(x=>x.w&&x.w.id==wcur.id);if(el)fd.scrollTop=el.offsetTop},50)}
function drawChat(){if(!curChat)return;let f=document.createDocumentFragment();curChat.msgs.forEach((m,i)=>{let mine=m.sender_id===acc.uid,d=document.createElement('div');d.className='ch-msg '+(mine?'me':'granter');d.innerHTML=(m.body?'<div class="ch-bubble">'+esc(m.body)+'</div>':'')+((m.media||[]).length?'<div class="ch-media">'+m.media.map((x,j)=>'<div class="mm '+(x.type==='video'?'v':'')+'" data-j="'+j+'">'+(x.type==='video'?'<video src="'+esc(x.url)+'" preload="metadata"></video>':'<img src="'+esc(x.url)+'">')+'</div>').join('')+'</div>':'')+'<div class="ch-meta"><span class="ch-time">sent '+dt(Date.parse(m.created_at))+(m.edited_at?' (edited)':'')+(mine&&m.read_at?' · seen':'')+'</span>'+(mine?'<b onclick="editChatMsg('+i+')">edit</b><b class="d" onclick="delChatMsg('+i+')">del</b>':'')+'</div>';d.querySelectorAll('.mm').forEach(el=>el.onclick=()=>openMedia(m.media,+el.dataset.j));f.append(d)});$('ch-list').replaceChildren(f);$('ch-list').scrollTop=$('ch-list').scrollHeight}
$('ch-txt').addEventListener('input',()=>{let n=Date.now();if(curChat&&curChat.ch&&n-lastT>1500){lastT=n;try{W.typing(curChat.ch,acc.uid)}catch(e){}}});
/* === EXAMPLES + COMPETITION === */
const EX={1:[['https://i.postimg.cc/52KCrTS9/IMG-20261127-115849-443.jpg','image'],['https://i.postimg.cc/tCC7HDTV/IMG-20261127-115859-266.jpg','image'],['https://files.catbox.moe/18r5of.mp4','video']],2:[['https://i.postimg.cc/FsRF6RWT/IMG-20261127-121335-141.jpg','image'],['https://i.postimg.cc/Y2XMQ7rf/IMG-20261127-121326-658.jpg','image'],['https://files.catbox.moe/rm5l80.mp4','video']],3:[['https://i.postimg.cc/W3NcJWxg/IMG-20261127-121319-427.jpg','image'],['https://i.postimg.cc/jdw0NJkY/IMG-20261127-121312-144.jpg','image'],['https://files.catbox.moe/ii9qga.mp4','video']]};
function loadPins(){document.querySelectorAll('.pin').forEach(p=>{let [n,i]=p.dataset.k.split('-'),m=EX[n]&&EX[n][+i];if(!m||p.dataset.ok)return;p.dataset.ok=1;p.innerHTML=m[1]==='video'?`<video src="${m[0]}" muted autoplay loop playsinline preload="metadata"></video>`:`<img src="${m[0]}" decoding="async">`;p.onclick=()=>openMedia(EX[n].map(x=>({url:x[0],type:x[1]})),+i)})}
let RK={};
function badge(p){if(p>92)return '';let t=p<=3?['#ffd54a','#a87400']:p<=30?['#e0b94a','#8a6d1d']:p<=61?['#c9ced6','#6b7280']:['#d9955a','#7a4a1a'];return `<svg viewBox="0 0 40 40" width="36" height="36">${p<=3?'<defs><radialGradient id="g'+p+'"><stop offset="0" stop-color="#fff6c2"/><stop offset="1" stop-color="'+t[0]+'"/></radialGradient></defs>':''}<circle cx="20" cy="20" r="17" fill="${p<=3?'url(#g'+p+')':t[0]}" stroke="${t[1]}" stroke-width="${p<=3?4:3}"/>${p<=3?'<path d="M9 17l5 4 6-9 6 9 5-4-2 12H11z" fill="#fff" stroke="'+t[1]+'" stroke-width="1.5"/>':'<path d="M20 9l3 7 7 .6-5.3 4.7 1.6 7.2L20 24.8l-6.3 3.7 1.6-7.2L10 16.6l7-.6z" fill="#fff"/>'}</svg>`}
async function renderRank(){let box=$('se-default-area');try{let rows=await W.ranking();RK={};let h='<div class="se-title">COMPETITION</div>';rows.forEach(r=>{RK[r.user_id]=r;h+=`<div class="se-comp-box"><div class="se-comp-left"><span class="se-comp-num">${r.position}.</span><div class="se-comp-circle">${r.pic_url?`<img src="${esc(r.pic_url)}" style="width:100%;height:100%;object-fit:cover">`:''}</div><span style="font-size:.7rem;font-weight:700;color:#0000a0">${r.fulfilled} wishes</span></div><div class="se-comp-more" onclick="rankMore('${r.user_id}')">MORE</div><div class="se-comp-right" style="border:none">${badge(+r.position)}</div></div>`});if(!rows.length)h+='<div class="se-empty">No granters yet. Be the first.</div>';box.innerHTML=h}catch(e){console.error(e)}}
function rankMore(id){let r=RK[id];if(!r)return;$('m-name').textContent=r.name;$('m-age').textContent=r.age;$('m-gen').textContent=r.gender;$('m-cty').textContent=r.country;$('ms').classList.add('sh')}
async function showPos(){try{let g=await W.myGranter();if(!g)return toast('Create a granter account first to see your position');let r=await W.myRank(acc.uid);$('pos-overlay').querySelector('.pos-num').textContent=r?r.position:'-';$('pos-overlay').classList.add('sh')}catch(e){}}
/* === GRANTER ACCOUNT + PAYMENTS === */
const PRICE_KES=260;
let gAcc=null,gEdit=0,gpic=null,pendingW=null;
async function shrink(f){try{let b=await createImageBitmap(f),k=Math.min(1,512/Math.max(b.width,b.height)),c=document.createElement('canvas');c.width=Math.round(b.width*k);c.height=Math.round(b.height*k);c.getContext('2d').drawImage(b,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(r,'image/jpeg',.85))}catch(e){return f}}
$('file-gpic').onchange=async e=>{let f=e.target.files[0];e.target.value='';if(!f)return;gpic=await shrink(f);let im=$('g-pic');im.src=URL.createObjectURL(gpic);im.style.display='block'};
function resetG(){gEdit=0;gpic=null;['g-name','g-country','g-age','g-gender','g-business'].forEach(k=>$(k).value='');$('g-pic').style.display='none';$('g-h').textContent='CREATE A GRANTER ACCOUNT FIRST';$('g-del').style.display='none'}
function fillG(){let g=gAcc||{};$('g-name').value=g.name||'';$('g-country').value=g.country||'';$('g-age').value=g.age||'';$('g-gender').value=g.gender||'';$('g-business').value=g.business||'';gpic=null;if(g.pic_url){$('g-pic').src=g.pic_url;$('g-pic').style.display='block'}$('g-h').textContent='EDIT YOUR GRANTER ACCOUNT';$('g-del').style.display='block'}
function gBack(){gEdit?go(8):go(6)}
function gbYes(){$('gb').classList.remove('sh');gEdit=1;fillG();go(11)}
function gbNo(){$('gb').classList.remove('sh');leaveChat()}
async function saveGranter(){let v=k=>$(k).value.trim(),a={name:v('g-name'),country:v('g-country'),age:v('g-age'),gender:$('g-gender').value,business:v('g-business'),pic_url:gAcc&&gAcc.pic_url};if(!a.name||!a.country||!a.age||!a.gender||!a.business)return alert('Please fill in all fields.');if(!gpic&&!a.pic_url)return alert('Please upload a profile picture.');try{gAcc=await W.saveGranter(a,gpic);gpic=null;if(gEdit){gEdit=0;go(8)}else go(12)}catch(e){alert(e.message)}}
const delG=()=>ask('This permanently deletes your granter account. Type DELETE to confirm.',1,async()=>{try{await W.deleteGranter()}catch(e){return alert(e.message)}gAcc=null;gEdit=0;leaveChat();toast('Granter account deleted')},'Delete');
function payBusy(x){let b=$('pay-btn');b.style.opacity=x?.6:1;b.style.pointerEvents=x?'none':'';b.textContent=x?'Processing...':'2$'}
async function payFor(kind,extra,done){try{let u=await W.user();if(!window.PaystackPop)return alert('Payment could not load. Check your internet and try again.');let ref='wg-'+kind+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);payBusy(1);PaystackPop.setup({key:W.PAYSTACK_PUBLIC_KEY,email:u.email,amount:PRICE_KES*100,currency:'KES',ref,metadata:{uid:u.id,kind,...extra},callback:function(r){confirmPay(r.reference,done)},onClose:function(){payBusy(0)}}).openIframe()}catch(e){payBusy(0);alert(e.message)}}
async function confirmPay(ref,done){try{let r=await W.sb.functions.invoke('paystack',{body:{reference:ref}});if(r.error)throw r.error;let d=r.data;if(!d||!d.ok)throw new Error((d&&d.error)||'not confirmed');if(done)await done(d)}catch(e){alert('We could not confirm your payment yet. If money left your account it will be applied or refunded automatically. '+(e.message||''))}payBusy(0)}
function payLock(){if(!pendingW)return;let w=pendingW;payFor('lock',{wish_id:w.id},async d=>{if(!d.locked){alert('Sorry, another granter locked this wish first. Your payment is being refunded.');return go(6)}w.granter_id=acc.uid;await openChat(w,'granter')})}
/* === WISH DONE TICK + NOTIFICATIONS === */
function tickWish(id){let w=wc[id];if(!w)return;if(!w.granter_id)return toast('A granter must lock your wish first');
  if(!w.done)return ask("By doing this you will confirm that your wish has been done. This decision can't be changed until one month ends.",0,()=>doDone(id,true),'Confirm');
  if(Date.now()-w.doneAt<2592000000)return toast('You can change this after one month');
  ask('Remove the tick from this wish?',0,()=>doDone(id,false),'Confirm')}
async function doDone(id,d){try{await W.setDone(id,d);await loadMine()}catch(e){toast(/WAIT/.test(e.message)?'You can change this after one month':e.message)}}
let nSkip=0,NT={},NTF=[];
const leaveNotifs=()=>{nSkip=1;go(5)};
const ntCol=(o,k)=>{NT[k]=o;return `<div class="col"><div class="cir">${o.pic_url?`<img src="${esc(o.pic_url)}">`:''}</div><div class="mb" onclick="ntMore('${k}')">MORE</div></div>`};
function ntMore(k){let o=NT[k];if(!o)return;$('m-name').textContent=o.name||'';$('m-age').textContent=o.age||'';$('m-gen').textContent=o.gender||'';$('m-cty').textContent=o.country||'';$('ms').classList.add('sh')}
async function ntDel(k,el){try{await W.delNotifs(k==='f'?NTF:[k])}catch(e){}el.closest('.nc').remove();if(!$('nt-grid').children.length)leaveNotifs()}
async function ntUnlock(id,el){try{await W.releaseLock(id);toast('Your wish is open to other granters again');el.closest('.nc').remove();await loadMine();if(!$('nt-grid').children.length)leaveNotifs()}catch(e){toast('You can unlock after 7 days without a reply')}}
async function checkNotifs(){if(nSkip){nSkip=0;return}try{
  let [n,u]=await Promise.all([W.notifs(),W.unlockable()]);if(!n.length&&!u.length||!$('s5').classList.contains('on'))return;
  let ful=n.filter(x=>x.kind==='fulfilled'),rem=n.filter(x=>x.kind==='removed'),f=ful.length||rem.length?await W.fulfilled():[],c=f.length,h='';NT={};NTF=ful.map(x=>x.id);
  if(ful.length)h+=`<div class="nc w"><span class="nx" onclick="ntDel('f',this)">X</span><div class="row">${f.map(x=>ntCol(x.owner||{},'f'+x.id)).join('')}</div><div style="text-transform:uppercase;font-size:1rem;font-weight:700">CONGRATULATIONS 🎉<br>YOU HAVE FULFILLED ${c} WISH${c==1?'':'ES'} .</div></div>`;
  for(const x of rem){let p=await W.profileInfo(x.payload.wisher_id)||{};h+=`<div class="nc"><span class="nx" onclick="ntDel('${x.id}',this)">X</span>${ntCol(p,'r'+x.id)}<div>A wisher has just removed you from wish done list . So now you have fulfilled ${c} wish${c==1?'':'es'} only .</div></div>`}
  u.forEach(id=>{let w=wc[id];h+=`<div class="nc"><span class="nx" onclick="this.closest('.nc').remove()">X</span><b>${esc(w?w.title:'')}</b><div style="color:#000;font-size:.72rem">If your current granter is not actively participating, you can release this lock.<br>Your wish will be re-opened to other granters who are ready and willing to fulfil your wish.</div><div class="ub" onclick="ntUnlock('${id}',this)">UNLOCK YOUR WISH</div></div>`});
  $('nt-grid').innerHTML=h;go(13)}catch(e){console.error(e)}}
boot();
