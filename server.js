import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});

app.use(express.json());
app.use(express.static("public"));

function getToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function clientFor(token) {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
}

async function auth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบ" });

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({
        error: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"
      });
    }

    req.user = data.user;
    req.sb = clientFor(token);

    const { data: profile } = await req.sb
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .maybeSingle();

    req.profile = profile || null;
    next();
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: "กรุณาเข้าสู่ระบบ" });
  }
}

function admin(req, res, next) {
  if (!req.profile?.is_admin) {
    return res.status(403).json({ error: "เฉพาะผู้ดูแลระบบ" });
  }
  next();
}

async function ensureWallet(sb, userId) {
  const { data: wallet } = await sb
    .from("wallets")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (wallet) return wallet;

  const { data: created, error } = await sb
    .from("wallets")
    .insert({
      user_id: userId,
      pending_balance: 0,
      available_balance: 0,
      balance: 0,
      total_earned: 0
    })
    .select("*")
    .single();

  if (error) throw error;
  return created;
}

app.get("/api/health", (_, res) => {
  res.json({ ok: true, service: "EarnJoy API" });
});

/* Auth */

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password || password.length < 6) {
      return res.status(400).json({
        error: "กรอกชื่อ อีเมล และรหัสผ่านอย่างน้อย 6 ตัวอักษร"
      });
    }

    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: { name }
      }
    });

    if (error) return res.status(400).json({ error: error.message });

    if (!data.user) {
      return res.status(400).json({ error: "สร้างบัญชีไม่สำเร็จ" });
    }

    if (!data.session) {
      return res.json({
        message: "สมัครสำเร็จ กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ",
        needsEmailConfirmation: true
      });
    }

    const sb = clientFor(data.session.access_token);

    const { error: profileError } = await sb
      .from("profiles")
      .upsert({
        id: data.user.id,
        username: email.trim().toLowerCase(),
        full_name: name
      }, { onConflict: "id" });

    if (profileError) {
      return res.status(400).json({
        error: "สร้างโปรไฟล์ไม่สำเร็จ: " + profileError.message
      });
    }

    await ensureWallet(sb, data.user.id);

    res.json({
      token: data.session.access_token,
      user: {
        id: data.user.id,
        name,
        email: data.user.email,
        balance: 0,
        pending: 0,
        totalEarned: 0
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการสมัครสมาชิก"
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(email || "").trim().toLowerCase(),
      password: String(password || "")
    });

    if (error || !data.session || !data.user) {
      return res.status(401).json({
        error: error?.message || "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
      });
    }

    const sb = clientFor(data.session.access_token);

    let { data: profile } = await sb
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .maybeSingle();

    if (!profile) {
      const { data: created, error: pe } = await sb
        .from("profiles")
        .upsert({
          id: data.user.id,
          username: data.user.email,
          full_name: data.user.user_metadata?.name || ""
        }, { onConflict: "id" })
        .select("*")
        .single();

      if (pe) return res.status(400).json({ error: pe.message });
      profile = created;
    }

    const wallet = await ensureWallet(sb, data.user.id);

    res.json({
      token: data.session.access_token,
      user: {
        id: data.user.id,
        name: profile.full_name || data.user.user_metadata?.name || "",
        email: data.user.email,
        balance: Number(wallet.balance || 0),
        pending: Number(wallet.pending_balance || 0),
        totalEarned: Number(wallet.total_earned || 0)
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ"
    });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const wallet = await ensureWallet(req.sb, req.user.id);

    res.json({
      user: {
        id: req.user.id,
        name: req.profile?.full_name ||
          req.user.user_metadata?.name || "",
        email: req.user.email,
        balance: Number(wallet.balance || 0),
        pending: Number(wallet.pending_balance || 0),
        totalEarned: Number(wallet.total_earned || 0)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Missions */

app.get("/api/missions", auth, async (req, res) => {
  const { data, error } = await req.sb
    .from("missions")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (error) return res.status(400).json({ error: error.message });

  res.json(data || []);
});

app.post("/api/missions/:id/claim", auth, async (req, res) => {
  try {
    const missionId = req.params.id;

    const { data: mission, error: me } = await req.sb
      .from("missions")
      .select("*")
      .eq("id", missionId)
      .eq("active", true)
      .maybeSingle();

    if (me) return res.status(400).json({ error: me.message });
    if (!mission) {
      return res.status(404).json({ error: "ไม่พบภารกิจ" });
    }

    const { data: oldClaim, error: ce } = await req.sb
      .from("mission_claims")
      .select("id,status")
      .eq("user_id", req.user.id)
      .eq("mission_id", missionId)
      .neq("status", "rejected")
      .maybeSingle();

    if (ce) return res.status(400).json({ error: ce.message });

    if (oldClaim) {
      return res.status(409).json({
        error: "คุณทำภารกิจนี้ไปแล้ว"
      });
    }

    const { data: claim, error: ie } = await req.sb
      .from("mission_claims")
      .insert({
        user_id: req.user.id,
        mission_id: missionId,
        reward: mission.reward,
        status: "pending"
      })
      .select("*")
      .single();

    if (ie) return res.status(400).json({ error: ie.message });

    const wallet = await ensureWallet(req.sb, req.user.id);

    const newPending =
      Number(wallet.pending_balance || 0) +
      Number(mission.reward || 0);

    const { error: we } = await req.sb
      .from("wallets")
      .update({
        pending_balance: newPending
      })
      .eq("user_id", req.user.id);

    if (we) return res.status(400).json({ error: we.message });

    res.json({
      message: "ส่งภารกิจแล้ว รอการตรวจสอบ",
      claim
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* Transactions */

app.get("/api/transactions", auth, async (req, res) => {
  const { data, error } = await req.sb
    .from("transactions")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(400).json({ error: error.message });

  res.json(data || []);
});

/* Withdrawals */

app.post("/api/withdrawals", auth, async (req, res) => {
  try {
    const { amount, method, destination } = req.body || {};
    const n = Number(amount);

    if (!Number.isFinite(n) || n < 500) {
      return res.status(400).json({
        error: "ถอนขั้นต่ำ ฿500"
      });
    }

    const wallet = await ensureWallet(req.sb, req.user.id);

    if (n > Number(wallet.balance || 0)) {
      return res.status(400).json({
        error: "ยอดเงินไม่พอ"
      });
    }

    const { data: withdrawal, error } = await req.sb
      .from("withdrawals")
      .insert({
        user_id: req.user.id,
        amount: n,
        method,
        destination,
        status: "pending"
      })
      .select("*")
      .single();

    if (error) return res.status(400).json({ error: error.message });

    const { error: we } = await req.sb
      .from("wallets")
      .update({
        balance: Number(wallet.balance || 0) - n
      })
      .eq("user_id", req.user.id);

    if (we) return res.status(400).json({ error: we.message });

    res.json({
      message: "ส่งคำขอถอนเงินแล้ว รอการตรวจสอบ",
      withdrawal
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Admin */

app.post("/api/admin/setup", async (req, res) => {
  try {
    const { email, password, name = "EarnJoy Admin" } = req.body || {};

    if (!email || !password || password.length < 6) {
      return res.status(400).json({
        error: "ต้องระบุ email และรหัสผ่านอย่างน้อย 6 ตัว"
      });
    }

    const { data: admins, error: ae } = await supabase
      .from("profiles")
      .select("id")
      .eq("is_admin", true)
      .limit(1);

    if (ae) return res.status(400).json({ error: ae.message });

    if (admins?.length) {
      return res.status(409).json({
        error: "มี admin แล้ว"
      });
    }

    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: { name }
      }
    });

    if (error) return res.status(400).json({ error: error.message });

    if (!data.user || !data.session) {
      return res.status(400).json({
        error: "สร้างบัญชีแล้ว แต่ต้องยืนยันอีเมลก่อน จึงตั้งเป็น Admin ได้"
      });
    }

    const sb = clientFor(data.session.access_token);

    const { data: profile, error: pe } = await sb
      .from("profiles")
      .upsert({
        id: data.user.id,
        username: email.trim().toLowerCase(),
        full_name: name,
        is_admin: true
      }, { onConflict: "id" })
      .select("*")
      .single();

    if (pe) return res.status(400).json({ error: pe.message });

    await ensureWallet(sb, data.user.id);

    res.json({
      message: "สร้าง admin แล้ว",
      token: data.session.access_token,
      user: profile
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/overview", auth, admin, async (req, res) => {
  const [users, claims, withdrawals] = await Promise.all([
    req.sb
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("is_admin", false),

    req.sb
      .from("mission_claims")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),

    req.sb
      .from("withdrawals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
  ]);

  res.json({
    users: users.count || 0,
    pendingClaims: claims.count || 0,
    pendingWithdrawals: withdrawals.count || 0
  });
});

app.get("/api/admin/claims", auth, admin, async (req, res) => {
  const { data, error } = await req.sb
    .from("mission_claims")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) return res.status(400).json({ error: error.message });

  res.json({
    claims: data || []
  });
});

app.post("/api/admin/claims/:id/approve", auth, admin, async (req, res) => {
  try {
    const id = req.params.id;

    const { data: claim, error: ce } = await req.sb
      .from("mission_claims")
      .select("*")
      .eq("id", id)
      .eq("status", "pending")
      .maybeSingle();

    if (ce) return res.status(400).json({ error: ce.message });

    if (!claim) {
      return res.status(404).json({
        error: "รายการไม่อยู่ในสถานะรอตรวจ"
      });
    }

    const { data: wallet, error: we } = await req.sb
      .from("wallets")
      .select("*")
      .eq("user_id", claim.user_id)
      .maybeSingle();

    if (we) return res.status(400).json({ error: we.message });

    if (!wallet) {
      return res.status(404).json({
        error: "ไม่พบกระเป๋าเงินผู้ใช้"
      });
    }

    const reward = Number(claim.reward || 0);

    const { error: cu } = await req.sb
      .from("mission_claims")
      .update({
        status: "approved",
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "pending");

    if (cu) return res.status(400).json({ error: cu.message });

    const { error: wu } = await req.sb
      .from("wallets")
      .update({
        pending_balance:
          Math.max(0, Number(wallet.pending_balance || 0) - reward),

        balance:
          Number(wallet.balance || 0) + reward,

        available_balance:
          Number(wallet.available_balance || 0) + reward,

        total_earned:
          Number(wallet.total_earned || 0) + reward
      })
      .eq("user_id", claim.user_id);

    if (wu) return res.status(400).json({ error: wu.message });

    const { error: txe } = await req.sb
      .from("transactions")
      .insert({
        user_id: claim.user_id,
        type: "reward",
        amount: reward,
        status: "approved",
        ref: String(claim.id)
      });

    if (txe) console.error("transaction insert:", txe);

    res.json({
      message: "อนุมัติรางวัลแล้ว"
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/claims/:id/reject", auth, admin, async (req, res) => {
  try {
    const id = req.params.id;

    const { data: claim, error: ce } = await req.sb
      .from("mission_claims")
      .select("*")
      .eq("id", id)
      .eq("status", "pending")
      .maybeSingle();

    if (ce) return res.status(400).json({ error: ce.message });

    if (!claim) {
      return res.status(404).json({
        error: "รายการไม่อยู่ในสถานะรอตรวจ"
      });
    }

    const { error: cu } = await req.sb
      .from("mission_claims")
      .update({
        status: "rejected",
        reviewed_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("status", "pending");

    if (cu) return res.status(400).json({ error: cu.message });

    const { data: wallet } = await req.sb
      .from("wallets")
      .select("*")
      .eq("user_id", claim.user_id)
      .maybeSingle();

    if (wallet) {
      await req.sb
        .from("wallets")
        .update({
          pending_balance: Math.max(
            0,
            Number(wallet.pending_balance || 0) -
            Number(claim.reward || 0)
          )
        })
        .eq("user_id", claim.user_id);
    }

    res.json({
      message: "ปฏิเสธรายการแล้ว"
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/withdrawals", auth, admin, async (req, res) => {
  const { data, error } = await req.sb
    .from("withdrawals")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(400).json({ error: error.message });

  res.json(data || []);
});

app.post("/api/admin/withdrawals/:id/approve", auth, admin, async (req, res) => {
  const { data, error } = await req.sb
    .from("withdrawals")
    .update({
      status: "approved",
      reviewed_at: new Date().toISOString()
    })
    .eq("id", req.params.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) return res.status(400).json({ error: error.message });

  if (!data) {
    return res.status(404).json({
      error: "ไม่พบรายการถอนเงิน"
    });
  }

  res.json({
    message: "อนุมัติการถอนเงินแล้ว"
  });
});

app.post("/api/admin/withdrawals/:id/reject", auth, admin, async (req, res) => {
  const { data: w, error: we } = await req.sb
    .from("withdrawals")
    .select("*")
    .eq("id", req.params.id)
    .eq("status", "pending")
    .maybeSingle();

  if (we) return res.status(400).json({ error: we.message });

  if (!w) {
    return res.status(404).json({
      error: "ไม่พบรายการถอนเงิน"
    });
  }

  const { error: ue } = await req.sb
    .from("withdrawals")
    .update({
      status: "rejected",
      reviewed_at: new Date().toISOString()
    })
    .eq("id", w.id)
    .eq("status", "pending");

  if (ue) return res.status(400).json({ error: ue.message });

  const { data: wallet } = await req.sb
    .from("wallets")
    .select("*")
    .eq("user_id", w.user_id)
    .maybeSingle();

  if (wallet) {
    await req.sb
      .from("wallets")
      .update({
        balance:
          Number(wallet.balance || 0) +
          Number(w.amount || 0)
      })
      .eq("user_id", w.user_id);
  }

  res.json({
    message: "ปฏิเสธการถอนเงินและคืนยอดแล้ว"
  });
});

app.get("/{*splat}", (_, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`EarnJoy API running on port ${PORT}`);
});
