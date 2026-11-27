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
    catch (e) { if (/WISH_LIMIT/.test(e.message)) e.limit = true; throw e; }   // limit = time to pay $2 for 20 more
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
