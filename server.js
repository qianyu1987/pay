'use strict';
/**
 * 好友借条 v2 · 多用户一对一借条工具平台
 * 定位与合规（平台免责边界）：
 *  1. 平台仅为借贷双方提供借条生成、还款计划、记账提醒等辅助工具；
 *  2. 平台不参与任何资金往来（无代收/代付/托管，收款由双方自行完成）；
 *  3. 平台不审核借条真实性，不核实借贷事实，风险由借贷双方自行承担；
 *  4. 利率由用户自由约定，平台仅作红字风险提示（司法保护上限=LPR4倍，超出部分不受法律保护）；
 *  5. 仅限自然人之间一对一借贷记账，不向不特定公众提供撮合服务。
 * 存储：JSON 文件（data/db.json，原子写），零原生依赖。
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 8931;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- 简单 JSON 存储（原子写） ---------------- */
function defaultDb() {
  return {
    secret: crypto.randomBytes(32).toString('hex'),
    seq: 1000,
    users: [],   // {id, phone, name, idcard, passwordHash, salt, payQr:{wechatImg,alipayImg,bank}, createdAt}
    loans: []    // {id, no, token, lenderId, borrower:{name,phone,idcard}, amountCents, ratePct, startDate, endDate, repayMethod, purpose, note, status, confirmAt, repayments, createdAt}
  };
}
function loadDb() {
  if (!fs.existsSync(DB_FILE)) return defaultDb();
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return defaultDb(); }
}
let db = loadDb();
if (!Array.isArray(db.users)) db.users = [];
if (!Array.isArray(db.loans)) db.loans = [];
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------------- 工具 ---------------- */
function yuanToCents(y) { return Math.round(Number(y || 0) * 100); }
function centsToYuan(c) { return (c / 100).toFixed(2); }
function fmtD(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function today() { return fmtD(new Date()); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return fmtD(d);
}
const LPR4 = 12.4; // 一年期LPR(3.1%)×4 司法保护上限提示值（动态概念，此处为提示基准）

/** 单利计息：本金(分) × 年利率% × 天数 / 365 */
function calcInterest(amountCents, ratePct, days) {
  if (!ratePct || days <= 0) return 0;
  return Math.round(amountCents * ratePct * days / 100 / 365);
}

/* ---------------- 还款计划生成 ---------------- */
/**
 * repayMethod:
 *  lump              到期一次性还本付息
 *  monthly_interest  按月付息（整月），到期还本
 *  equal_installment 按月等额本息
 */
function buildSchedule(loan) {
  const { amountCents, ratePct, startDate, endDate, repayMethod } = loan;
  const totalDays = Math.max(0, daysBetween(startDate, endDate));
  const list = [];
  if (repayMethod === 'monthly_interest') {
    const monthInterest = Math.round(amountCents * ratePct / 100 / 12);
    let idx = 1, cur = startDate, guard = 0;
    while (guard++ < 600) {
      const next = addMonths(cur, 1);
      if (next >= endDate) break;
      list.push({ idx, dueDate: next, principalCents: 0, interestCents: monthInterest, totalCents: monthInterest, kind: 'interest', paidCents: 0 });
      cur = next; idx++;
    }
    // 末期：还本 + 最后一期利息（按整月近似）
    list.push({ idx, dueDate: endDate, principalCents: amountCents, interestCents: monthInterest, totalCents: amountCents + monthInterest, kind: 'principal+interest', paidCents: 0 });
    return list;
  }
  if (repayMethod === 'equal_installment') {
    let months = 0, cur = startDate, guard = 0;
    while (guard++ < 600) { const next = addMonths(cur, 1); if (next >= endDate) break; cur = next; months++; }
    months = Math.max(1, months + 1); // 含末期
    const r = ratePct / 100 / 12;
    let per;
    if (r <= 0) per = Math.round(amountCents / months);
    else per = Math.round(amountCents * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1));
    let remainP = amountCents;
    for (let i = 1; i <= months; i++) {
      const isLast = i === months;
      const interest = Math.round(remainP * r);
      let principal = per - interest;
      if (isLast) principal = remainP; // 尾差归末期
      const due = isLast ? endDate : addMonths(startDate, i);
      list.push({ idx: i, dueDate: due, principalCents: principal, interestCents: interest, totalCents: principal + interest, kind: 'installment', paidCents: 0 });
      remainP -= principal;
    }
    return list;
  }
  // 默认：到期一次性还本付息
  const interest = calcInterest(amountCents, ratePct, totalDays);
  return [{ idx: 1, dueDate: endDate, principalCents: amountCents, interestCents: interest, totalCents: amountCents + interest, kind: 'lump', paidCents: 0 }];
}

/** 借期总利息（与计划一致：一次性按天数；分期按计划合计） */
function loanInterest(loan) {
  if (loan.repayMethod === 'monthly_interest') {
    let months = 0, cur = loan.startDate, guard = 0;
    while (guard++ < 600) { const next = addMonths(cur, 1); if (next >= loan.endDate) break; cur = next; months++; }
    return Math.round(loan.amountCents * loan.ratePct / 100 / 12) * (months + 1);
  }
  if (loan.repayMethod === 'equal_installment') {
    return buildSchedule(loan).reduce((s, x) => s + x.interestCents, 0);
  }
  return calcInterest(loan.amountCents, loan.ratePct, Math.max(0, daysBetween(loan.startDate, loan.endDate)));
}
function confirmedTotal(loan) {
  return (loan.repayments || []).filter(r => r.status === 'confirmed').reduce((s, r) => s + (r.amountCents || 0), 0);
}
function nextNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  db.seq += 1;
  return `JT-${ymd}-${db.seq}`;
}

/** 借条对外视图（脱敏：身份证打码；role: lender|borrower|pub） */
function loanView(loan, role, viewer) {
  const interest = loanInterest(loan);
  const repaid = confirmedTotal(loan);
  const schedule = buildSchedule(loan);
  const lender = db.users.find(u => u.id === loan.lenderId) || { name: '(已注销)', phone: '', idcard: '' };
  const mask = s => (s || '').length > 6 ? String(s).slice(0, 3) + '***********' + String(s).slice(-4) : '***';
  const state = loan.status === 'paid' ? 'paid'
    : loan.status === 'cancelled' ? 'cancelled'
    : loan.status === 'rejected' ? 'rejected'
    : loan.status === 'pending' ? 'pending'
    : today() > loan.endDate ? 'overdue' : 'active';
  return {
    id: loan.id, no: loan.no, token: loan.token, status: loan.status, state,
    repayMethod: loan.repayMethod,
    lender: { name: lender.name, phone: lender.phone, idcard: role === 'pub' ? mask(lender.idcard) : lender.idcard },
    borrower: { name: loan.borrower.name, phone: loan.borrower.phone, idcard: role === 'pub' ? mask(loan.borrower.idcard) : loan.borrower.idcard },
    amountYuan: centsToYuan(loan.amountCents), amountCents: loan.amountCents,
    ratePct: loan.ratePct, rateOverLpr4: loan.ratePct > LPR4,
    startDate: loan.startDate, endDate: loan.endDate,
    days: Math.max(0, daysBetween(loan.startDate, loan.endDate)),
    purpose: loan.purpose || '', note: loan.note || '',
    interestCents: interest, interestYuan: centsToYuan(interest),
    dueTotalCents: loan.amountCents + interest, dueTotalYuan: centsToYuan(loan.amountCents + interest),
    repaidCents: repaid, repaidYuan: centsToYuan(repaid),
    remainCents: Math.max(0, loan.amountCents + interest - repaid), remainYuan: centsToYuan(Math.max(0, loan.amountCents + interest - repaid)),
    schedule: schedule.map(s => ({ ...s, dueYuan: centsToYuan(s.totalCents) })),
    confirmAt: loan.confirmAt || null,
    confirmName: loan.confirmName || '',
    repayments: (loan.repayments || []).slice().reverse().map(r => ({
      id: r.id, amountYuan: centsToYuan(r.amountCents), amountCents: r.amountCents,
      method: r.method, ref: r.ref || '', note: r.note || '',
      voucher: r.voucher || null, voucherName: r.voucherName || null,
      submittedAt: r.submittedAt, confirmedAt: r.confirmedAt || null, status: r.status,
      confirmNote: r.confirmNote || ''
    })),
    payQr: viewer === 'lender-full' ? undefined : (lender.payQr || {}),
    createdAt: loan.createdAt
  };
}

/* ---------------- 认证（手机号+密码，HMAC cookie 会话） ---------------- */
function sign(data) { return crypto.createHmac('sha256', db.secret).update(data).digest('hex'); }
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function genSalt() { return crypto.randomBytes(16).toString('hex'); }
function sessionToken(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 30 * 86400000 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function currentUser(req) {
  try {
    const t = (req.cookiesJar || '').trim();
    if (!t) return null;
    const [payload, sig] = t.split('.');
    if (!payload || sig !== sign(payload)) return null;
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (exp < Date.now()) return null;
    return db.users.find(u => u.id === uid) || null;
  } catch (e) { return null; }
}
const PHONE_RE = /^1[3-9]\d{9}$/;
const IDCARD_RE = /^\d{17}[\dXx]$/;

/* ---------------- 上传（收款码/还款凭证） ---------------- */
const storage = multer.diskStorage({
  destination: (req, f, cb) => cb(null, UPLOAD_DIR),
  filename: (req, f, cb) => {
    const ext = (path.extname(f.originalname) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'].includes(path.extname(f.originalname).toLowerCase());
    cb(ok ? null : new Error('仅支持图片'), ok);
  }
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use((req, res, next) => {
  req.cookiesJar = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('iou_s='))?.slice(6) || '';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
function needLogin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ ok: false, msg: '请先登录' });
  req.user = u;
  next();
}
function setSessionCookie(res, uid) { res.setHeader('Set-Cookie', `iou_s=${sessionToken(uid)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`); }
function clearSessionCookie(res) { res.setHeader('Set-Cookie', `iou_s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); }

/* ================= 认证 API ================= */
app.post('/api/auth/register', (req, res) => {
  const b = req.body || {};
  const phone = String(b.phone || '').trim();
  const password = String(b.password || '');
  const name = String(b.name || '').trim();
  const idcard = String(b.idcard || '').trim().toUpperCase();
  if (!PHONE_RE.test(phone)) return res.status(400).json({ ok: false, msg: '请填写正确的手机号' });
  if (password.length < 6) return res.status(400).json({ ok: false, msg: '密码至少 6 位' });
  if (!name) return res.status(400).json({ ok: false, msg: '请填写真实姓名（将写入借条）' });
  if (!IDCARD_RE.test(idcard)) return res.status(400).json({ ok: false, msg: '请填写正确的 18 位身份证号' });
  if (!b.agree) return res.status(400).json({ ok: false, msg: '请阅读并同意《用户协议》与《隐私政策》' });
  if (db.users.some(u => u.phone === phone)) return res.status(400).json({ ok: false, msg: '该手机号已注册，请直接登录' });
  const salt = genSalt();
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    phone, name, idcard,
    passwordHash: hashPassword(password, salt), salt,
    payQr: { wechatImg: '', alipayImg: '', bank: '' },
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDb();
  setSessionCookie(res, user.id);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const phone = String((req.body || {}).phone || '').trim();
  const password = String((req.body || {}).password || '');
  const u = db.users.find(x => x.phone === phone);
  if (!u || !crypto.timingSafeEqual(Buffer.from(hashPassword(password, u.salt)), Buffer.from(u.passwordHash))) {
    return res.status(401).json({ ok: false, msg: '手机号或密码错误' });
  }
  setSessionCookie(res, u.id);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ ok: true, loggedIn: false, lpr4: LPR4 });
  res.json({
    ok: true, loggedIn: true, lpr4: LPR4,
    user: { id: u.id, phone: u.phone, name: u.name, idcard: u.idcard, payQr: u.payQr, createdAt: u.createdAt }
  });
});
/* 更新实名资料 */
app.put('/api/me/profile', needLogin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const idcard = String(b.idcard || '').trim().toUpperCase();
  if (!name) return res.status(400).json({ ok: false, msg: '请填写真实姓名' });
  if (!IDCARD_RE.test(idcard)) return res.status(400).json({ ok: false, msg: '请填写正确的 18 位身份证号' });
  req.user.name = name; req.user.idcard = idcard;
  saveDb();
  res.json({ ok: true });
});
/* 收款方式（各填各的，平台不经手资金） */
app.get('/api/me/payqr', needLogin, (req, res) => {
  const p = req.user.payQr || {};
  res.json({ ok: true, wechatImg: p.wechatImg || '', alipayImg: p.alipayImg || '', bank: p.bank || '' });
});
app.put('/api/me/payqr', needLogin, (req, res) => {
  const b = req.body || {};
  req.user.payQr = req.user.payQr || { wechatImg: '', alipayImg: '', bank: '' };
  if (b.bank !== undefined) req.user.payQr.bank = String(b.bank).trim();
  if (b.wechatImg !== undefined) req.user.payQr.wechatImg = b.wechatImg ? String(b.wechatImg) : '';
  if (b.alipayImg !== undefined) req.user.payQr.alipayImg = b.alipayImg ? String(b.alipayImg) : '';
  saveDb();
  res.json({ ok: true });
});
app.post('/api/me/payqr/upload', needLogin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: '未收到图片' });
  const type = req.body.type === 'alipay' ? 'alipay' : 'wechat';
  req.user.payQr = req.user.payQr || { wechatImg: '', alipayImg: '', bank: '' };
  const old = req.user.payQr[type + 'Img'];
  if (old && fs.existsSync(path.join(UPLOAD_DIR, path.basename(old)))) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(old))); } catch (e) {} }
  req.user.payQr[type + 'Img'] = '/uploads/' + req.file.filename;
  saveDb();
  res.json({ ok: true, url: req.user.payQr[type + 'Img'] });
});

/* ================= 借条 API ================= */
/* 我的借条（我借出的 / 我借入的，按手机号匹配） */
app.get('/api/loans/mine', needLogin, (req, res) => {
  const me = req.user;
  const asLender = db.loans.filter(l => l.lenderId === me.id);
  const asBorrower = db.loans.filter(l => l.borrower.phone === me.phone);
  const s = (arr, role) => arr.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(l => loanView(l, role));
  res.json({
    ok: true,
    asLender: s(asLender, 'lender'),
    asBorrower: s(asBorrower, 'borrower')
  });
});

/* 创建借条（放款人操作，定向发给借款人手机号） */
app.post('/api/loans', needLogin, (req, res) => {
  const b = req.body || {};
  const me = req.user;
  const name = String(b.borrowerName || '').trim();
  const phone = String(b.borrowerPhone || '').trim();
  const idcard = String(b.borrowerIdcard || '').trim().toUpperCase();
  const amountCents = yuanToCents(b.amount);
  const ratePct = Math.max(0, Number(b.ratePct) || 0);
  if (!name) return res.status(400).json({ ok: false, msg: '请填写借款人姓名' });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ ok: false, msg: '请填写借款人手机号（借条将定向发送给该手机号注册的账号）' });
  if (!IDCARD_RE.test(idcard)) return res.status(400).json({ ok: false, msg: '请填写借款人 18 位身份证号' });
  if (!amountCents || amountCents <= 0) return res.status(400).json({ ok: false, msg: '请填写正确的借款金额' });
  if (phone === me.phone) return res.status(400).json({ ok: false, msg: '不能给自己创建借条' });
  if (!b.startDate || !b.endDate) return res.status(400).json({ ok: false, msg: '请选择借款起止日期' });
  if (b.endDate <= b.startDate) return res.status(400).json({ ok: false, msg: '到期日必须晚于借款日' });
  const repayMethod = ['lump', 'monthly_interest', 'equal_installment'].includes(b.repayMethod) ? b.repayMethod : 'lump';
  // 利率自由约定 + 强制风险确认（不拦截，但必须勾选已知悉）
  if (ratePct > LPR4 && !b.riskAck) {
    return res.status(400).json({ ok: false, msg: `年利率 ${ratePct}% 已超过司法保护上限（LPR4倍，约${LPR4}%），超出部分利息不受法律保护，请勾选已知悉风险后继续` });
  }
  const loan = {
    id: crypto.randomBytes(8).toString('hex'),
    token: crypto.randomBytes(12).toString('hex'),
    no: nextNo(),
    lenderId: me.id,
    borrower: { name, phone, idcard },
    amountCents, ratePct,
    startDate: b.startDate, endDate: b.endDate,
    repayMethod,
    purpose: String(b.purpose || '').trim(),
    note: String(b.note || '').trim(),
    status: 'pending',          // 待借款人确认
    confirmAt: null, confirmName: '',
    repayments: [],
    createdAt: new Date().toISOString()
  };
  db.loans.push(loan);
  saveDb();
  res.json({
    ok: true, loan: loanView(loan, 'lender'),
    link: `${req.protocol}://${req.get('host')}/p/${loan.token}`,
    msg: '借条已创建，等待借款人登录确认'
  });
});

function findMine(req, res) {
  const me = req.user;
  const l = db.loans.find(x => x.id === req.params.id);
  if (!l) { res.status(404).json({ ok: false, msg: '借条不存在' }); return null; }
  const isLender = l.lenderId === me.id;
  const isBorrower = l.borrower.phone === me.phone;
  if (!isLender && !isBorrower) { res.status(403).json({ ok: false, msg: '无权查看该借条' }); return null; }
  return { l, role: isLender ? 'lender' : 'borrower' };
}

app.get('/api/loans/:id', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  res.json({ ok: true, loan: loanView(f.l, f.role), role: f.role, link: `${req.protocol}://${req.get('host')}/p/${f.l.token}` });
});

/* 借款人确认借款（双方合意） */
app.post('/api/loans/:id/confirm', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l, role } = f;
  if (role !== 'borrower') return res.status(403).json({ ok: false, msg: '只有借款人可以确认借条' });
  if (l.status !== 'pending') return res.status(400).json({ ok: false, msg: l.confirmAt ? '该借条已确认' : '当前状态不可确认' });
  if (req.user.name !== l.borrower.name) {
    return res.status(400).json({ ok: false, msg: `实名不一致：该借条指定借款人为「${l.borrower.name}」，当前账号实名「${req.user.name}」，请核对后联系出借人更正` });
  }
  l.status = 'confirmed';
  l.confirmAt = new Date().toISOString();
  l.confirmName = req.user.name;
  saveDb();
  res.json({ ok: true, msg: '借条已确认生效', loan: loanView(l, role) });
});
/* 借款人驳回（信息有误） */
app.post('/api/loans/:id/reject', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l, role } = f;
  if (role !== 'borrower') return res.status(403).json({ ok: false, msg: '只有借款人可以驳回' });
  if (l.status !== 'pending') return res.status(400).json({ ok: false, msg: '当前状态不可驳回' });
  l.status = 'rejected';
  l.rejectNote = String((req.body || {}).note || '').trim();
  saveDb();
  res.json({ ok: true, msg: '借条已驳回，请让出借人修改后重新发送' });
});
/* 放款人作废待确认借条 */
app.post('/api/loans/:id/cancel', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l, role } = f;
  if (role !== 'lender') return res.status(403).json({ ok: false, msg: '只有出借人可以作废' });
  if (confirmedTotal(l) > 0) return res.status(400).json({ ok: false, msg: '已有确认到账的还款记录，不能作废' });
  l.status = 'cancelled';
  saveDb();
  res.json({ ok: true, msg: '借条已作废' });
});
/* 放款人编辑待确认借条（被驳回后修改重发） */
app.put('/api/loans/:id', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l, role } = f;
  if (role !== 'lender') return res.status(403).json({ ok: false, msg: '只有出借人可以修改' });
  if (l.status !== 'rejected' && l.status !== 'pending') return res.status(400).json({ ok: false, msg: '仅待确认/被驳回的借条可以修改' });
  const b = req.body || {};
  const ratePct = Math.max(0, Number(b.ratePct) || 0);
  if (ratePct > LPR4 && !b.riskAck) return res.status(400).json({ ok: false, msg: `年利率 ${ratePct}% 超过司法保护上限（约${LPR4}%），请勾选已知悉风险` });
  if (b.amount !== undefined) { const c = yuanToCents(b.amount); if (!c || c <= 0) return res.status(400).json({ ok: false, msg: '金额无效' }); l.amountCents = c; }
  if (b.ratePct !== undefined) l.ratePct = ratePct;
  if (b.startDate) l.startDate = b.startDate;
  if (b.endDate) { if (b.endDate <= l.startDate) return res.status(400).json({ ok: false, msg: '到期日必须晚于借款日' }); l.endDate = b.endDate; }
  if (b.repayMethod && ['lump', 'monthly_interest', 'equal_installment'].includes(b.repayMethod)) l.repayMethod = b.repayMethod;
  if (b.purpose !== undefined) l.purpose = String(b.purpose).trim();
  if (b.note !== undefined) l.note = String(b.note).trim();
  l.status = 'pending'; // 修改后重新待确认
  l.rejectNote = '';
  saveDb();
  res.json({ ok: true, msg: '借条已修改并重新发送确认', loan: loanView(l, 'lender') });
});

/* 借款人提交还款凭证（线下转账，平台不经手资金） */
app.post('/api/loans/:id/repay', needLogin, upload.single('voucher'), (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l, role } = f;
  if (role !== 'borrower') return res.status(403).json({ ok: false, msg: '只有借款人可以提交还款' });
  if (l.status === 'cancelled' || l.status === 'rejected') return res.status(400).json({ ok: false, msg: '该借条未生效' });
  if (l.status === 'paid') return res.status(400).json({ ok: false, msg: '该笔借款已结清' });
  if (!l.confirmAt) return res.status(400).json({ ok: false, msg: '请先确认借条后再提交还款' });
  const method = String(req.body.method || '');
  if (!['wechat', 'alipay', 'bank', 'cash'].includes(method)) return res.status(400).json({ ok: false, msg: '请选择转账方式' });
  const amountCents = yuanToCents(req.body.amount);
  if (!amountCents || amountCents <= 0) return res.status(400).json({ ok: false, msg: '请填写转账金额' });
  const r = {
    id: crypto.randomBytes(8).toString('hex'),
    amountCents, method,
    ref: String(req.body.ref || '').trim(),
    note: String(req.body.note || '').trim(),
    voucher: req.file ? '/uploads/' + req.file.filename : null,
    voucherName: req.file ? req.file.originalname : null,
    submittedAt: new Date().toISOString(),
    confirmedAt: null, status: 'pending', confirmNote: ''
  };
  l.repayments.push(r);
  saveDb();
  res.json({ ok: true, msg: '提交成功，等待出借人确认到账' });
});
/* 出借人确认/驳回还款 */
app.post('/api/loans/:id/repay/:rid/confirm', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l, role } = f;
  if (role !== 'lender') return res.status(403).json({ ok: false, msg: '只有出借人可以确认到账' });
  const r = (l.repayments || []).find(x => x.id === req.params.rid);
  if (!r) return res.status(404).json({ ok: false, msg: '还款记录不存在' });
  const actual = req.body.actualAmount !== undefined && req.body.actualAmount !== null && req.body.actualAmount !== ''
    ? yuanToCents(req.body.actualAmount) : r.amountCents;
  r.amountCents = actual;
  r.status = 'confirmed';
  r.confirmedAt = new Date().toISOString();
  r.confirmNote = String(req.body.note || '').trim();
  if (confirmedTotal(l) >= l.amountCents + loanInterest(l)) l.status = 'paid';
  saveDb();
  res.json({ ok: true, loan: loanView(l, 'lender') });
});
app.post('/api/loans/:id/repay/:rid/reject', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l, role } = f;
  if (role !== 'lender') return res.status(403).json({ ok: false, msg: '只有出借人可以驳回' });
  const r = (l.repayments || []).find(x => x.id === req.params.rid);
  if (!r) return res.status(404).json({ ok: false, msg: '还款记录不存在' });
  r.status = 'rejected';
  r.confirmNote = String(req.body.note || '已驳回').trim();
  saveDb();
  res.json({ ok: true, loan: loanView(l, 'lender') });
});

/* .ics 日历文件：还款计划导入手机日历（提醒还款日+金额） */
app.get('/api/loans/:id/calendar', needLogin, (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const { l } = f;
  if (!l.confirmAt) return res.status(400).json({ ok: false, msg: '借条确认后才能导出还款计划' });
  const schedule = buildSchedule(l);
  const pad = s => '0' + s;
  function icsDate(d) { return d.replace(/-/g, '') + 'T090000'; } // 上午9点提醒
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IOU Friend//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:还款计划-${l.borrower.name}`
  ];
  schedule.forEach(s => {
    const uid = `${l.no}-${s.idx}@iou`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
      `DTSTART;TZID=Asia/Shanghai:${icsDate(s.dueDate)}`,
      `DTEND;TZID=Asia/Shanghai:${icsDate(s.dueDate)}`,
      `SUMMARY:还款提醒 ${l.no} 第${s.idx}期 ¥${centsToYuan(s.totalCents)}`,
      `DESCRIPTION:借条编号 ${l.no}\\n借款人 ${l.borrower.name}\\n本期应还 ¥${centsToYuan(s.totalCents)}（本金¥${centsToYuan(s.principalCents)} + 利息¥${centsToYuan(s.interestCents)}）\\n到期日 ${s.dueDate}\\n请通过出借人收款方式完成还款并提交凭证。`,
      'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY',
      `DESCRIPTION:明天是还款日：${l.no} 第${s.idx}期 ¥${centsToYuan(s.totalCents)}`, 'END:VALARM',
      'END:VEVENT'
    );
  });
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="repay-${l.no}.ics"`);
  res.send(lines.join('\r\n'));
});

/* 分享二维码（指向公开借条页） */
app.get('/api/loans/:id/qrcode', needLogin, async (req, res) => {
  const f = findMine(req, res); if (!f) return;
  const url = `${req.protocol}://${req.get('host')}/p/${f.l.token}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 640, color: { dark: '#16324f', light: '#ffffff' } });
    res.json({ ok: true, url, dataUrl });
  } catch (e) { res.status(500).json({ ok: false, msg: '二维码生成失败' }); }
});

/* ================= 公开借条页（免登录查看，确认需登录） ================= */
app.get('/api/p/:token', (req, res) => {
  const l = db.loans.find(x => x.token === req.params.token);
  if (!l) return res.status(404).json({ ok: false, msg: '未找到该借条，请核对链接' });
  const me = currentUser(req);
  res.json({ ok: true, loan: loanView(l, 'pub'), loggedIn: !!me, isBorrower: !!(me && me.phone === l.borrower.phone) });
});

/* ================= 页面 ================= */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/u', (req, res) => res.sendFile(path.join(__dirname, 'public', 'u.html')));
app.get('/u/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'u.html')));
app.get('/p/:token', (req, res) => {
  if (!db.loans.find(x => x.token === req.params.token)) return res.status(404).send('<h3 style="font-family:sans-serif;text-align:center;margin-top:20vh">未找到该借条，请核对链接是否正确</h3>');
  res.sendFile(path.join(__dirname, 'public', 'pub.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => console.log(`[好友借条v2] http://localhost:${PORT}`));
