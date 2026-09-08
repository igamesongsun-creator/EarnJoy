import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createClient } from 
  "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_SECRET_IN_PRODUCTION";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function initialDb() {
  return {
    users: [],
    missions: [
      {id: "m1", title: "สำรวจข้อเสนอ", description: "อ่านรายละเอียดข้อเสนอและทำตามเงื่อนไข", reward: 10, type: "task", active: true},
      {id: "m2", title: "ช้อปสินค้าผ่าน Affiliate", description: "ซื้อสินค้าที่ร่วมรายการตามเงื่อนไขของแคมเปญ", reward: 80, type: "affiliate", active: true},
      {id: "m3", title: "ตอบแบบสอบถาม", description: "ตอบแบบสอบถามตามคุณสมบัติของแคมเปญ", reward: 25, type: "task", active: true}
    ],
    missionClaims: [],
    transactions: [],
    withdrawals: []
  };
}
function loadDb() {
  fs.mkdirSync(DATA_DIR, {recursive:true});
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(initialDb(), null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function tokenFor(user) { return jwt.sign({id:user.id, role:user.role}, JWT_SECRET, {expiresIn:"7d"}); }
function auth(req,res,next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({error:"กรุณาเข้าสู่ระบบ"}); }
}
function admin(req,res,next) {
  if (req.auth?.role !== "admin") return res.status(403).json({error:"เฉพาะผู้ดูแลระบบ"});
  next();
}
function uid(prefix="id") { return prefix + "_" + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

app.get("/api/health", (_,res)=>res.json({ok:true, service:"EarnJoy API"}));

app.post("/api/auth/register", async (req,res)=>{
  const {name,email,password} = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({error:"กรอกชื่อ อีเมล และรหัสผ่านอย่างน้อย 6 ตัวอักษร"});
  const db = loadDb();
  if (db.users.some(u=>u.email.toLowerCase()===email.toLowerCase())) return res.status(409).json({error:"อีเมลนี้มีบัญชีแล้ว"});
  const user = {id:uid("u"), name, email:email.toLowerCase(), passwordHash:await bcrypt.hash(password,10), role:"member", balance:0, pending:0, totalEarned:0, createdAt:new Date().toISOString()};
  db.users.push(user); saveDb(db);
  res.json({token:tokenFor(user), user:{id:user.id,name:user.name,email:user.email,balance:0,pending:0,totalEarned:0}});
});

app.post("/api/auth/login", async (req,res)=>{
  const {email,password} = req.body || {};
  const db = loadDb();
  const user = db.users.find(u=>u.email===String(email||"").toLowerCase());
  if (!user || !(await bcrypt.compare(password||"", user.passwordHash))) return res.status(401).json({error:"อีเมลหรือรหัสผ่านไม่ถูกต้อง"});
  res.json({token:tokenFor(user), user:{id:user.id,name:user.name,email:user.email,balance:user.balance,pending:user.pending,totalEarned:user.totalEarned,role:user.role}});
});

app.get("/api/me", auth, (req,res)=>{
  const db=loadDb(); const u=db.users.find(x=>x.id===req.auth.id);
  if(!u) return res.status(404).json({error:"ไม่พบผู้ใช้"});
  res.json({id:u.id,name:u.name,email:u.email,balance:u.balance,pending:u.pending,totalEarned:u.totalEarned,role:u.role});
});

app.get("/api/missions", auth, (_,res)=>{
  const db=loadDb(); res.json(db.missions.filter(m=>m.active));
});

app.post("/api/missions/:id/claim", auth, (req,res)=>{
  const db=loadDb(); const m=db.missions.find(x=>x.id===req.params.id && x.active);
  if(!m) return res.status(404).json({error:"ไม่พบภารกิจ"});
  if(db.missionClaims.some(c=>c.userId===req.auth.id && c.missionId===m.id && c.status!=="rejected")) return res.status(409).json({error:"คุณทำภารกิจนี้ไปแล้ว"});
  const claim={id:uid("clm"),userId:req.auth.id,missionId:m.id,reward:m.reward,status:"pending",createdAt:new Date().toISOString()};
  db.missionClaims.push(claim);
  const u=db.users.find(x=>x.id===req.auth.id); u.pending+=m.reward; saveDb(db);
  res.json({message:"ส่งภารกิจแล้ว รอการตรวจสอบ",claim});
});

app.get("/api/transactions", auth, (req,res)=>{
  const db=loadDb(); res.json(db.transactions.filter(t=>t.userId===req.auth.id).slice(-50).reverse());
});

app.post("/api/withdrawals", auth, (req,res)=>{
  const {amount, method, destination} = req.body || {};
  const n=Number(amount); const db=loadDb(); const u=db.users.find(x=>x.id===req.auth.id);
  if(!Number.isFinite(n) || n < 500) return res.status(400).json({error:"ยอดถอนขั้นต่ำ 500 บาทใน MVP นี้"});
  if(n > u.balance) return res.status(400).json({error:"ยอดพร้อมรับไม่เพียงพอ"});
  if(!method || !destination) return res.status(400).json({error:"กรุณาระบุช่องทางและข้อมูลรับเงิน"});
  const w={id:uid("wd"),userId:u.id,amount:n,method,destination,status:"pending",createdAt:new Date().toISOString()};
  u.balance-=n; db.withdrawals.push(w);
  db.transactions.push({id:uid("tx"),userId:u.id,type:"withdrawal",amount:-n,status:"pending",ref:w.id,createdAt:w.createdAt});
  saveDb(db); res.json({message:"รับคำขอถอนแล้ว รอแอดมินตรวจสอบ",withdrawal:w});
});

// Admin
app.post("/api/admin/setup", async (req,res)=>{
  const {email,password,name="EarnJoy Admin"}=req.body||{};
  if(!email || !password) return res.status(400).json({error:"ต้องระบุ email/password"});
  const db=loadDb();
  if(db.users.some(u=>u.role==="admin")) return res.status(409).json({error:"มี admin แล้ว"});
  const u={id:uid("admin"),name,email:email.toLowerCase(),passwordHash:await bcrypt.hash(password,10),role:"admin",balance:0,pending:0,totalEarned:0,createdAt:new Date().toISOString()};
  db.users.push(u);saveDb(db);res.json({message:"สร้าง admin แล้ว",token:tokenFor(u)});
});
app.get("/api/admin/overview", auth, admin, (_,res)=>{
  const db=loadDb();
  res.json({users:db.users.filter(u=>u.role==="member").length,claims:db.missionClaims.length,pendingWithdrawals:db.withdrawals.filter(w=>w.status==="pending").length,withdrawalVolume:db.withdrawals.reduce((s,w)=>s+w.amount,0)});
});
app.get("/api/admin/claims", auth, admin, (_,res)=>{
  const db=loadDb();
  res.json(db.missionClaims.map(c=>({...c,user:db.users.find(u=>u.id===c.userId)?.email,mission:db.missions.find(m=>m.id===c.missionId)?.title})).reverse());
});
app.post("/api/admin/claims/:id/approve", auth, admin, (req,res)=>{
  const db=loadDb(); const c=db.missionClaims.find(x=>x.id===req.params.id);
  if(!c || c.status!=="pending") return res.status(404).json({error:"รายการไม่อยู่ในสถานะรอตรวจ"});
  const u=db.users.find(x=>x.id===c.userId); c.status="approved"; c.approvedAt=new Date().toISOString();
  u.pending-=c.reward; u.balance+=c.reward; u.totalEarned+=c.reward;
  db.transactions.push({id:uid("tx"),userId:u.id,type:"reward",amount:c.reward,status:"approved",ref:c.id,createdAt:new Date().toISOString()});
  saveDb(db);res.json({message:"อนุมัติรางวัลแล้ว"});
});
app.post("/api/admin/claims/:id/reject", auth, admin, (req,res)=>{
  const db=loadDb(); const c=db.missionClaims.find(x=>x.id===req.params.id);
  if(!c || c.status!=="pending") return res.status(404).json({error:"รายการไม่อยู่ในสถานะรอตรวจ"});
  const u=db.users.find(x=>x.id===c.userId); c.status="rejected"; u.pending-=c.reward; saveDb(db);res.json({message:"ปฏิเสธภารกิจแล้ว"});
});
app.get("/api/admin/withdrawals", auth, admin, (_,res)=>{
  const db=loadDb();
  res.json(db.withdrawals.map(w=>({...w,user:db.users.find(u=>u.id===w.userId)?.email})).reverse());
});
app.post("/api/admin/withdrawals/:id/approve", auth, admin, (req,res)=>{
  const db=loadDb(); const w=db.withdrawals.find(x=>x.id===req.params.id);
  if(!w || w.status!=="pending") return res.status(404).json({error:"รายการไม่อยู่ในสถานะรอตรวจ"});
  w.status="approved"; w.processedAt=new Date().toISOString(); saveDb(db);res.json({message:"อนุมัติการถอนแล้ว — ขั้นตอนโอนเงินจริงต้องเชื่อมผู้ให้บริการที่รองรับ"});
});
app.post("/api/admin/withdrawals/:id/reject", auth, admin, (req,res)=>{
  const db=loadDb(); const w=db.withdrawals.find(x=>x.id===req.params.id);
  if(!w || w.status!=="pending") return res.status(404).json({error:"รายการไม่อยู่ในสถานะรอตรวจ"});
  const u=db.users.find(x=>x.id===w.userId); u.balance+=w.amount; w.status="rejected"; w.processedAt=new Date().toISOString();
  db.transactions.push({id:uid("tx"),userId:u.id,type:"withdrawal_refund",amount:w.amount,status:"approved",ref:w.id,createdAt:new Date().toISOString()});
  saveDb(db);res.json({message:"ปฏิเสธและคืนยอดแล้ว"});
});

app.get("/{*splat}", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT,()=>console.log(`EarnJoy running at http://localhost:${PORT}`));
