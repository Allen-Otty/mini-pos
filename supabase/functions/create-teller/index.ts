import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Creates a teller/manager login for the calling admin's business.
// - The email is pre-confirmed, so the teller can sign in straight away.
// - If the admin gives no password, a random one is set and the teller is emailed a
//   "set your password" link (Supabase password-reset email). Nobody ever sees the password.
// - If the admin does give a password (6+ chars) it is used as a temporary password.
function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const a = crypto.getRandomValues(new Uint32Array(24));
  return Array.from(a, (n) => chars[n % chars.length]).join("");
}

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) return json({ error: "Invalid session" }, 401);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: callerProfile, error: profileErr } = await adminClient
      .from("profiles").select("role, business_id").eq("id", user.id).single();
    if (profileErr || !callerProfile || callerProfile.role !== "admin") {
      return json({ error: "Only admins can create teller accounts" }, 403);
    }

    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    const full_name = body.full_name;
    const redirect_to = typeof body.redirect_to === "string" && /^https?:\/\//.test(body.redirect_to) ? body.redirect_to : undefined;
    const given = typeof body.password === "string" ? body.password : "";
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "A valid email is required" }, 400);
    const sendLink = given.length === 0;
    if (!sendLink && given.length < 6) return json({ error: "Password must be 6+ characters (or leave it blank to email a set-password link)" }, 400);

    const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password: sendLink ? randomPassword() : given,
      email_confirm: true,
    });
    if (createErr || !newUser?.user) return json({ error: createErr?.message || "Could not create account" }, 400);

    const { error: insertErr } = await adminClient.from("profiles").insert({
      id: newUser.user.id,
      business_id: callerProfile.business_id,
      full_name: full_name || "",
      role: "teller",
      active: true,
    });
    if (insertErr) {
      await adminClient.auth.admin.deleteUser(newUser.user.id);
      return json({ error: insertErr.message }, 400);
    }

    let email_sent = false, email_error: string | null = null;
    if (sendLink) {
      const anon = createClient(supabaseUrl, anonKey);
      const { error: mailErr } = await anon.auth.resetPasswordForEmail(email, redirect_to ? { redirectTo: redirect_to } : undefined);
      email_sent = !mailErr;
      email_error = mailErr ? mailErr.message : null;
    }

    return json({ success: true, teller_id: newUser.user.id, user_id: newUser.user.id, email_sent, email_error });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
