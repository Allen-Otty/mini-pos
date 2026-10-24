import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const J = { ...cors, "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const { business_name, business_type, full_name, email, password, phone } = await req.json();
    if (!business_name || !full_name || !email || !password) {
      return new Response(JSON.stringify({ error: "Business name, your name, email, and password are all required" }), { status: 400, headers: J });
    }
    if (String(password).length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: J });
    }
    // Kenyan numbers normalised to 2547XXXXXXXX / 2541XXXXXXXX; anything else kept as typed (digits and +)
    let cleanPhone: string | null = null;
    if (phone) {
      const d = String(phone).replace(/[^\d+]/g, "");
      cleanPhone = /^0[17]\d{8}$/.test(d) ? "254" + d.slice(1)
        : /^\+?254[17]\d{8}$/.test(d) ? d.replace("+", "")
        : /^[17]\d{8}$/.test(d) ? "254" + d : d.slice(0, 20) || null;
    }

    // Create the auth user directly via the Admin API, pre-confirmed - no email
    // OTP/confirmation step. This endpoint IS the signup flow (verify_jwt=false).
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr) {
      const msg = /already.*registered|already.*exists/i.test(createErr.message)
        ? "This email is already registered. Please sign in instead."
        : createErr.message;
      return new Response(JSON.stringify({ error: msg }), { status: 400, headers: J });
    }
    const user = created.user;

    const { data: biz, error: bizErr } = await adminClient
      .from("businesses")
      .insert({ name: business_name, business_type: business_type || "Retail", owner_id: user.id })
      .select().single();
    if (bizErr) {
      await adminClient.auth.admin.deleteUser(user.id);
      return new Response(JSON.stringify({ error: bizErr.message }), { status: 400, headers: J });
    }

    const { error: profErr } = await adminClient.from("profiles").insert({
      id: user.id, business_id: biz.id, full_name: full_name || "", role: "admin", active: true,
    });
    if (profErr) {
      await adminClient.from("businesses").delete().eq("id", biz.id);
      await adminClient.auth.admin.deleteUser(user.id);
      return new Response(JSON.stringify({ error: profErr.message }), { status: 400, headers: J });
    }

    // Store the owner's contact next to the account. Best effort: never fail a signup over it
    // (also keeps working before the 20261024 migration adds the columns).
    await adminClient.from("businesses")
      .update({ owner_email: String(email).toLowerCase(), owner_phone: cleanPhone })
      .eq("id", biz.id);

    return new Response(JSON.stringify({ success: true, business_id: biz.id }), { headers: J });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: J });
  }
});
