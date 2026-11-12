import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Telegram control bot for the PLATFORM SUPER ADMIN only.
// - Webhook calls must carry Telegram's secret token header.
// - A chat is answered only after it was linked with a one-time code created inside the signed-in admin console.
// - Unlinked chats get no reply at all.

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ok = () => new Response("ok");

const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const nbi = (d: string | null) => d ? new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Nairobi", dateStyle: "medium", timeStyle: "short" }) : "never";
const kes = (n: number) => "KES " + Math.round(n).toLocaleString("en-KE");

async function tg(method: string, body: Record<string, unknown>) {
  if (!TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (_) { /* ignore */ }
}
const send = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const HELP = `<b>Dogo POS admin bot</b>
/stats – today at a glance
/signups [n] – newest businesses
/biz &lt;name&gt; – one business
/payments – payments needing attention
/suspend &lt;name&gt; – suspend a business
/activate &lt;name&gt; – reactivate
/extend &lt;name&gt; &lt;days&gt; – add subscription days
/unlink – disconnect this chat`;

async function findBiz(q: string) {
  const { data } = await admin.from("businesses")
    .select("id,name,business_type,active,subscription_plan,subscription_status,subscription_renews_at,owner_email,owner_phone,created_at,pending_plan")
    .ilike("name", `%${q.replace(/[%_]/g, "")}%`).order("created_at", { ascending: false }).limit(6);
  return data ?? [];
}

async function pickOne(chat: number, q: string) {
  if (!q) { await send(chat, "Add the business name, e.g. <code>/biz Mama Njeri</code>"); return null; }
  const rows = await findBiz(q);
  if (!rows.length) { await send(chat, `No business matches “${esc(q)}”.`); return null; }
  const exact = rows.find((r) => r.name.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  if (rows.length > 1) {
    await send(chat, "Several match. Be more specific:\n" + rows.map((r) => "• " + esc(r.name)).join("\n"));
    return null;
  }
  return rows[0];
}

async function lastSeen(bizId: string) {
  const { data } = await admin.from("profiles").select("last_seen_at,last_seen_platform").eq("business_id", bizId)
    .not("last_seen_at", "is", null).order("last_seen_at", { ascending: false }).limit(1);
  return data && data[0] ? `${nbi(data[0].last_seen_at)} (${data[0].last_seen_platform ?? "?"})` : "never";
}

function bizCard(b: any, seen: string) {
  return `<b>${esc(b.name)}</b> · ${esc(b.business_type)}
Plan: ${esc(b.subscription_plan ?? "Free")} (${esc(b.subscription_status ?? "free")})${b.pending_plan ? " · awaiting payment for " + esc(b.pending_plan) : ""}
Renews: ${b.subscription_renews_at ? nbi(b.subscription_renews_at) : "—"}
Status: ${b.active ? "active ✅" : "suspended ⛔"}
Owner: ${esc(b.owner_email ?? "—")} · ${esc(b.owner_phone ?? "—")}
Joined: ${nbi(b.created_at)}
Last seen: ${esc(seen)}`;
}

async function stats(chat: number) {
  const now = Date.now();
  const iso = (h: number) => new Date(now - h * 3600e3).toISOString();
  const count = async (q: any) => (await q).count ?? 0;
  const [total, d1, d7, paid, seen, review] = await Promise.all([
    count(admin.from("businesses").select("id", { count: "exact", head: true })),
    count(admin.from("businesses").select("id", { count: "exact", head: true }).gte("created_at", iso(24))),
    count(admin.from("businesses").select("id", { count: "exact", head: true }).gte("created_at", iso(24 * 7))),
    count(admin.from("businesses").select("id", { count: "exact", head: true }).neq("subscription_plan", "Free").eq("subscription_status", "active")),
    count(admin.from("profiles").select("id", { count: "exact", head: true }).gte("last_seen_at", iso(24))),
    count(admin.from("subscription_payments").select("id", { count: "exact", head: true }).eq("needs_review", true)),
  ]);
  const { data: pay } = await admin.from("subscription_payments").select("amount_paid").eq("status", "paid").gte("applied_at", iso(24));
  const rev = (pay ?? []).reduce((s: number, r: any) => s + Number(r.amount_paid ?? 0), 0);
  await send(chat, `<b>Dogo POS today</b>
Businesses: ${total}
New: ${d1} (24h) · ${d7} (7 days)
Paying (active): ${paid}
Users seen in 24h: ${seen}
Subscription income (24h): ${kes(rev)}
Payments needing review: ${review}`);
}

async function audit(userId: string, bizId: string, action: string, details: Record<string, unknown>) {
  await admin.from("audit_log").insert({ business_id: bizId, actor_id: userId, actor_role: "platform_admin", action, target_table: "businesses", target_id: bizId, details });
}

async function askConfirm(chat: number, text: string, data: string) {
  await send(chat, text, { reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: data }, { text: "✖ Cancel", callback_data: "x" }]] } });
}

async function handleText(chat: number, userId: string, text: string) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, "");
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/start": case "/help": return send(chat, HELP);
    case "/stats": return stats(chat);
    case "/signups": {
      const n = Math.min(Math.max(parseInt(arg) || 5, 1), 15);
      const { data } = await admin.from("businesses").select("name,business_type,subscription_plan,pending_plan,owner_email,owner_phone,created_at").order("created_at", { ascending: false }).limit(n);
      return send(chat, "<b>Newest businesses</b>\n" + (data ?? []).map((b: any) =>
        `• <b>${esc(b.name)}</b> (${esc(b.business_type)}) ${esc(b.pending_plan ? "wants " + b.pending_plan : b.subscription_plan ?? "Free")}\n  ${esc(b.owner_email ?? "")} ${esc(b.owner_phone ?? "")} · ${nbi(b.created_at)}`).join("\n"));
    }
    case "/biz": { const b = await pickOne(chat, arg); if (b) await send(chat, bizCard(b, await lastSeen(b.id))); return; }
    case "/payments": {
      const { data } = await admin.from("subscription_payments").select("business_id,plan,amount_expected,amount_paid,status,review_note,mpesa_receipt,created_at")
        .or(`needs_review.eq.true,and(status.eq.pending,created_at.gte.${new Date(Date.now() - 86400e3).toISOString()})`).order("created_at", { ascending: false }).limit(10);
      if (!data?.length) return send(chat, "Nothing needs attention ✅");
      const ids = [...new Set(data.map((p: any) => p.business_id))];
      const { data: bs } = await admin.from("businesses").select("id,name").in("id", ids);
      const nm = new Map((bs ?? []).map((b: any) => [b.id, b.name]));
      return send(chat, "<b>Payments</b>\n" + data.map((p: any) =>
        `• ${esc(nm.get(p.business_id) ?? "?")} · ${esc(p.plan)} · ${esc(p.status)} · due ${kes(p.amount_expected)}${p.amount_paid ? ", paid " + kes(p.amount_paid) : ""}${p.mpesa_receipt ? " · " + esc(p.mpesa_receipt) : ""}${p.review_note ? "\n  " + esc(p.review_note) : ""}`).join("\n"));
    }
    case "/suspend": { const b = await pickOne(chat, arg); if (b) await askConfirm(chat, `Suspend <b>${esc(b.name)}</b>? Everyone in that business will be locked out.`, `s:${b.id}`); return; }
    case "/activate": { const b = await pickOne(chat, arg); if (b) await askConfirm(chat, `Reactivate <b>${esc(b.name)}</b>?`, `a:${b.id}`); return; }
    case "/extend": {
      const m = arg.match(/^(.*\S)\s+(\d{1,3})$/);
      if (!m) return send(chat, "Use: <code>/extend Business Name 30</code>");
      const days = parseInt(m[2]);
      if (days < 1 || days > 365) return send(chat, "Days must be 1–365.");
      const b = await pickOne(chat, m[1]); if (!b) return;
      if ((b.subscription_plan ?? "Free") === "Free") return send(chat, `${esc(b.name)} is on the Free plan, so there is nothing to extend.`);
      return askConfirm(chat, `Add <b>${days}</b> days to <b>${esc(b.name)}</b> (${esc(b.subscription_plan)})?`, `e:${b.id}:${days}`);
    }
    case "/unlink":
      await admin.from("admin_bot_links").delete().eq("chat_id", chat);
      return send(chat, "Disconnected. This chat will no longer be answered.");
    default: return send(chat, "I didn't understand that. Send /help.");
  }
}

async function handleCallback(cb: any, userId: string) {
  const chat = cb.message?.chat?.id as number; const mid = cb.message?.message_id;
  const done = (t: string) => tg("editMessageText", { chat_id: chat, message_id: mid, text: t, parse_mode: "HTML" });
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
  const [act, id, extra] = String(cb.data).split(":");
  if (act === "x") return done("Cancelled.");
  const { data: b } = await admin.from("businesses").select("id,name,subscription_renews_at,subscription_plan").eq("id", id).maybeSingle();
  if (!b) return done("Business not found.");
  if (act === "s") {
    await admin.from("businesses").update({ active: false, suspended_reason: "Suspended by platform admin (Telegram)", suspended_at: new Date().toISOString() }).eq("id", id);
    await audit(userId, id, "telegram.suspend", {}); return done(`⛔ <b>${esc(b.name)}</b> suspended.`);
  }
  if (act === "a") {
    await admin.from("businesses").update({ active: true, suspended_reason: null, suspended_at: null }).eq("id", id);
    await audit(userId, id, "telegram.activate", {}); return done(`✅ <b>${esc(b.name)}</b> reactivated.`);
  }
  if (act === "e") {
    const days = parseInt(extra);
    const base = b.subscription_renews_at && new Date(b.subscription_renews_at) > new Date() ? new Date(b.subscription_renews_at) : new Date();
    const next = new Date(base.getTime() + days * 86400e3).toISOString();
    await admin.from("businesses").update({ subscription_renews_at: next, subscription_status: "active" }).eq("id", id);
    await audit(userId, id, "telegram.extend", { days, renews_at: next });
    return done(`✅ <b>${esc(b.name)}</b> extended by ${days} days. New expiry: ${nbi(next)}.`);
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // One-time webhook registration: open  .../telegram-bot?setup=<TELEGRAM_WEBHOOK_SECRET>  in a browser.
  if (req.method === "GET") {
    const key = url.searchParams.get("setup");
    if (!TOKEN || !SECRET || !key || key !== SECRET) return new Response("Not found", { status: 404 });
    const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-bot`;
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: hook, secret_token: SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
    });
    return new Response(await r.text(), { headers: { "Content-Type": "application/json" } });
  }

  if (req.method !== "POST") return ok();
  if (!TOKEN || !SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) return new Response("forbidden", { status: 403 });

  try {
    const upd = await req.json();
    const msg = upd.message;
    const cb = upd.callback_query;
    const from = (msg?.from ?? cb?.from);
    const chat = (msg?.chat ?? cb?.message?.chat);
    if (!from || !chat || chat.type !== "private" || from.id !== chat.id) return ok();

    const { data: link } = await admin.from("admin_bot_links").select("user_id").eq("chat_id", chat.id).maybeSingle();
    let linked = !!link;
    if (linked) {
      // still a platform admin?
      const { data: pa } = await admin.from("platform_admins").select("id").eq("user_id", link!.user_id).maybeSingle();
      if (!pa) { await admin.from("admin_bot_links").delete().eq("chat_id", chat.id); linked = false; }
    }

    if (!linked) {
      // Only reaction allowed from an unlinked chat: "/link 123456". Everything else is ignored silently.
      const m = (msg?.text ?? "").trim().match(/^\/link(?:@\w+)?\s+(\d{6})$/i);
      if (!m) return ok();
      const since = new Date(Date.now() - 15 * 60e3).toISOString();
      const { count } = await admin.from("admin_bot_attempts").select("id", { count: "exact", head: true }).eq("chat_id", chat.id).gte("at", since);
      if ((count ?? 0) >= 5) return ok();
      await admin.from("admin_bot_attempts").insert({ chat_id: chat.id });
      const h = await sha256(m[1]);
      const { data: code } = await admin.from("admin_bot_codes").select("id,user_id").eq("code_hash", h).eq("used", false).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!code) return ok();
      await admin.from("admin_bot_codes").update({ used: true }).eq("id", code.id);
      await admin.from("admin_bot_links").upsert({ user_id: code.user_id, chat_id: chat.id, tg_username: from.username ?? null }, { onConflict: "chat_id" });
      await send(chat.id, "✅ Linked to your Dogo POS super admin account.\n\n" + HELP);
      return ok();
    }

    if (cb) await handleCallback(cb, link!.user_id);
    else if (msg?.text) await handleText(chat.id, link!.user_id, msg.text);
  } catch (e) {
    console.error("telegram-bot", String(e));
  }
  return ok();
});
