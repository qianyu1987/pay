'use strict';
/**
 * 朋友借条 · 好友间私人借贷工具
 * 合规原则：
 *  1. 网站不做资金托管/代收，仅生成借条、账单，借款人线下转账后提交凭证，出借人确认到账；
 *  2. 利率司法保护上限 = 合同成立时一年期LPR的4倍（当前约12%/年），超出部分不受法律保护；
 *  3. 仅限自然人朋友间借贷，不面向不特定公众吸储放贷。
 * 存储：JSON 文件（data/db.json），零原生依赖，便于跨服务器部署迁移。
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const wxpay = require('./lib/wxpay');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 8931;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- 简单 JSON 存储（原子写） ---------------- */
function defaultDb() {
  return {
    config: { lender: { name: '', idcard: '', phone: '' }, pay: {}, secret: crypto.randomBytes(32).toString('hex') },
    seq: 1000,
    loans: [],
    payOrders: [] // 微信 Native 在线支付订单：{ outTradeNo, loanToken, amountCents, status, createdAt, paidAt, txnId }
  };
}
function loadDb() {
  if (!fs.existsSync(DB_FILE)) return defaultDb();
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return defaultDb(); }
}
let db = loadDb();
if (!Array.isArray(db.payOrders)) db.payOrders = [];
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------------- 工具 ---------------- */
function yuanToCents(y) { return Math.round(Number(y || 0) * 100); }
function centsToYuan(c) { return (c / 100).toFixed(2); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
const LPR4 = 12; // 一年期LPR约3.0% ×4 = 12% 司法保护上限（可随最新LPR调整提示）

/** 单利计息：本金(分) × 年利率% × 天数 / 365 */
function calcInterest(amountCents, ratePct, days) {
  if (!ratePct || days <= 0) return 0;
  return Math.round(amountCents * ratePct * days / 100 / 365);
}
/** 借期利息 */
function loanInterest(loan) {
  const days = Math.max(0, daysBetween(loan.startDate, loan.endDate));
  return calcInterest(loan.amountCents, loan.ratePct, days);
}
/** 逾期至今额外利息（按原利率继续计，供提示用，实际以出借人确认为准） */
function overdueExtra(loan) {
  if (loan.status === 'paid' || loan.status === 'cancelled') return 0;
  const due = daysBetween(loan.endDate, today());
  if (due <= 0) return 0;
  return calcInterest(loan.amountCents, loan.ratePct || Math.max(0, 0), due);
}
/** 还款记录中被确认的金额合计(分) */
function confirmedTotal(loan) {
  return (loan.repayments || []).filter(r => r.status === 'confirmed').reduce((s, r) => s + (r.amountCents || 0), 0);
}
function nextNo() {
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  db.seq += 1;
  return `JD-${ym}-${db.seq}`;
}
function publicLoan(loan, withPayQr) {
  const interest = loanInterest(loan);
  const dueTotal = loan.amountCents + interest;
  const repaid = confirmedTotal(loan);
  const now = today();
  const state = loan.status === 'paid' ? 'paid'
    : loan.status === 'cancelled' ? 'cancelled'
    : now > loan.endDate ? 'overdue' : 'active';
  return {
    id: loan.id, no: loan.no, token: loan.token, status: loan.status, state,
    borrower: loan.borrower,
    lender: db.config.lender,
    amountYuan: centsToYuan(loan.amountCents),
    amountCents: loan.amountCents,
    ratePct: loan.ratePct,
    startDate: loan.startDate, endDate: loan.endDate,
    purpose: loan.purpose || '', note: loan.note || '',
    interestCents: interest, dueTotalCents: dueTotal, dueTotalYuan: centsToYuan(dueTotal),
    overdueExtraCents: overdueExtra(loan),
    days: Math.max(0, daysBetween(loan.startDate, loan.endDate)),
    pay: withPayQr ? db.config.pay : undefined,
    wxpayEnabled: withPayQr ? wxEnabled() : false,
    confirmedAt: loan.confirmedAt || null,
    repayments: (loan.repayments || []).slice().reverse().map(r => ({
      id: r.id, amountYuan: centsToYuan(r.amountCents), amountCents: r.amountCents,
      method: r.method, ref: r.ref || '', note: r.note || '',
      voucher: r.voucher || null, voucherName: r.voucherName || null,
      submittedAt: r.submittedAt, confirmedAt: r.confirmedAt || null, status: r.status,
      confirmNote: r.confirmNote || ''
    })),
    repaidCents: repaid, repaidYuan: centsToYuan(repaid),
    createdAt: loan.createdAt
  };
}

/* ---------------- 认证（HMAC cookie，无状态，重启不掉线） ---------------- */
function sign(data) { return crypto.createHmac('sha256', db.config.secret).update(data).digest('hex'); }
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function genSalt() { return crypto.randomBytes(16).toString('hex'); }
function adminToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 30 * 86400000 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function isAdmin(req) {
  try {
    const t = (req.cookiesJar || '').trim();
    if (!t) return false;
    const [payload, sig] = t.split('.');
    if (!payload || sig !== sign(payload)) return false;
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now();
  } catch (e) { return false; }
}

/* ---------------- 上传（凭证/收款码） ---------------- */
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
    const ok = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.pdf'].includes(path.extname(f.originalname).toLowerCase());
    cb(ok ? null : new Error('仅支持图片或PDF凭证'), ok);
  }
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
// 简易 cookie 解析（避免额外依赖）
app.use((req, res, next) => {
  req.cookiesJar = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('qj_admin='))?.slice(9) || '';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
function needAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, msg: '未登录或会话过期' });
  next();
}
function setAdminCookie(res) { res.setHeader('Set-Cookie', `qj_admin=${adminToken()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`); }
function clearAdminCookie(res) { res.setHeader('Set-Cookie', 'qj_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); }

/* ================= 管理端 API ================= */
app.get('/api/state', (req, res) => {
  const c = db.config;
  res.json({ ok: true, needSetup: !c.passwordHash, loggedIn: isAdmin(req), lender: c.lender, lpr4: LPR4 });
});
app.post('/api/setup', (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ ok: false, msg: '密码至少 6 位' });
  if (db.config.passwordHash) return res.status(400).json({ ok: false, msg: '已初始化，请直接登录' });
  const salt = genSalt();
  db.config.passwordHash = hashPassword(pw, salt);
  db.config.salt = salt;
  saveDb();
  setAdminCookie(res);
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const pw = String(req.body.password || '');
  const ok = db.config.passwordHash && crypto.timingSafeEqual(Buffer.from(hashPassword(pw, db.config.salt)), Buffer.from(db.config.passwordHash));
  if (!ok) return res.status(401).json({ ok: false, msg: '密码错误' });
  setAdminCookie(res);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { clearAdminCookie(res); res.json({ ok: true }); });

/* 设置：出借人信息 / 收款账户 */
app.put('/api/settings', needAdmin, (req, res) => {
  const { lender, password } = req.body || {};
  if (lender) {
    db.config.lender = { name: String(lender.name || '').trim(), idcard: String(lender.idcard || '').trim(), phone: String(lender.phone || '').trim() };
  }
  if (password && String(password).length >= 6) {
    const salt = genSalt();
    db.config.passwordHash = hashPassword(String(password), salt);
    db.config.salt = salt;
  }
  saveDb();
  res.json({ ok: true });
});
/* 收款方式查询/保存 */
app.get('/api/settings/pay', needAdmin, (req, res) => {
  const p = db.config.pay || {};
  res.json({ ok: true, wechatImg: p.wechatImg || '', alipayImg: p.alipayImg || '', bank: p.bank || '' });
});
app.put('/api/settings/pay', needAdmin, (req, res) => {
  const b = req.body || {};
  db.config.pay = db.config.pay || {};
  if (b.bank !== undefined) db.config.pay.bank = String(b.bank).trim();
  // 允许传 null 清空图片
  if (b.wechatImg !== undefined) db.config.pay.wechatImg = b.wechatImg ? String(b.wechatImg) : '';
  if (b.alipayImg !== undefined) db.config.pay.alipayImg = b.alipayImg ? String(b.alipayImg) : '';
  saveDb();
  res.json({ ok: true });
});

/* 上传收款码图片: field=image, query/field type=wechat|alipay */
app.post('/api/upload-payqr', needAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: '未收到图片' });
  const type = req.body.type === 'alipay' ? 'alipay' : 'wechat';
  db.config.pay = db.config.pay || {};
  const old = db.config.pay[type + 'Img'];
  if (old && fs.existsSync(path.join(UPLOAD_DIR, path.basename(old)))) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(old))); } catch (e) {} }
  db.config.pay[type + 'Img'] = '/uploads/' + req.file.filename;
  saveDb();
  res.json({ ok: true, url: db.config.pay[type + 'Img'] });
});

/* 借条列表：统计始终基于全部借条，列表按筛选/搜索返回 */
app.get('/api/loans', needAdmin, (req, res) => {
  const filter = req.query.filter || 'all';
  const q = String(req.query.q || '').toLowerCase();
  const all = db.loans.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let list = all;
  if (filter !== 'all') {
    list = all.filter(l => {
      const st = l.status === 'paid' ? 'paid' : l.status === 'cancelled' ? 'cancelled' : today() > l.endDate ? 'overdue' : 'active';
      return st === filter;
    });
  }
  if (q) list = list.filter(l => (l.borrower.name + l.borrower.phone + l.no + l.borrower.idcard).toLowerCase().includes(q));
  res.json({ ok: true, loans: list.map(l => publicLoan(l, false)), stats: statsOf(all) });
});
function statsOf(list) {
  let active = 0, overdue = 0, paid = 0, cancelled = 0, outCents = 0, repayCents = 0, todayDue = 0, remainCents = 0;
  const td = today();
  list.forEach(l => {
    const st = l.status === 'paid' ? 'paid' : l.status === 'cancelled' ? 'cancelled' : td > l.endDate ? 'overdue' : 'active';
    const due = l.amountCents + loanInterest(l);
    if (st === 'active') { active++; outCents += l.amountCents; remainCents += due - confirmedTotal(l); }
    if (st === 'overdue') { overdue++; outCents += l.amountCents; remainCents += due - confirmedTotal(l); }
    if (st === 'paid') paid++;
    if (st === 'cancelled') cancelled++;
    if (st === 'active' && l.endDate === td) todayDue++;
    repayCents += confirmedTotal(l);
  });
  return { active, overdue, paid, cancelled, todayDue, outYuan: centsToYuan(outCents), repayYuan: centsToYuan(repayCents), remainYuan: centsToYuan(remainCents) };
}

app.post('/api/loans', needAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const phone = String(b.phone || '').trim();
  const amountCents = yuanToCents(b.amount);
  if (!name) return res.status(400).json({ ok: false, msg: '请填写借款人姓名' });
  if (!amountCents || amountCents <= 0) return res.status(400).json({ ok: false, msg: '请填写正确的借款金额' });
  if (!b.startDate || !b.endDate) return res.status(400).json({ ok: false, msg: '请选择借款起止日期' });
  if (b.endDate < b.startDate) return res.status(400).json({ ok: false, msg: '到期日不能早于借款日' });
  const ratePct = Math.max(0, Number(b.ratePct) || 0);
  if (ratePct > LPR4) {
    // 允许，但必须显式确认风险
    if (!b.riskAck) return res.status(400).json({ ok: false, msg: `年利率超过司法保护上限(${LPR4}%)，超出部分不受法律保护，请确认风险` });
  }
  const loan = {
    id: crypto.randomBytes(8).toString('hex'),
    token: crypto.randomBytes(12).toString('hex'),
    no: nextNo(),
    borrower: { name, phone, idcard: String(b.idcard || '').trim() },
    amountCents, ratePct,
    startDate: b.startDate, endDate: b.endDate,
    purpose: String(b.purpose || '').trim(), note: String(b.note || '').trim(),
    status: 'active',
    repayments: [],
    createdAt: new Date().toISOString(),
    confirmedAt: null
  };
  db.loans.push(loan);
  saveDb();
  res.json({ ok: true, loan: publicLoan(loan, true), link: `${req.protocol}://${req.get('host')}/p/${loan.token}` });
});

app.get('/api/loans/:id', needAdmin, (req, res) => {
  const l = db.loans.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ ok: false, msg: '借条不存在' });
  res.json({ ok: true, loan: publicLoan(l, true), link: `${req.protocol}://${req.get('host')}/p/${l.token}`, no: l.no });
});

/* 确认收款：标记某条还款记录已到账，可修正实收金额 */
app.post('/api/loans/:id/repay/:rid/confirm', needAdmin, (req, res) => {
  const l = db.loans.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ ok: false, msg: '借条不存在' });
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
  res.json({ ok: true, loan: publicLoan(l, true) });
});
app.post('/api/loans/:id/repay/:rid/reject', needAdmin, (req, res) => {
  const l = db.loans.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ ok: false, msg: '借条不存在' });
  const r = (l.repayments || []).find(x => x.id === req.params.rid);
  if (!r) return res.status(404).json({ ok: false, msg: '还款记录不存在' });
  r.status = 'rejected';
  r.confirmNote = String(req.body.note || '已驳回').trim();
  saveDb();
  res.json({ ok: true, loan: publicLoan(l, true) });
});
/* 作废 / 恢复借条 */
app.post('/api/loans/:id/status', needAdmin, (req, res) => {
  const l = db.loans.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ ok: false, msg: '借条不存在' });
  const s = req.body.status;
  if (s === 'cancelled') l.status = 'cancelled';
  if (s === 'reactivate') l.status = 'active';
  saveDb();
  res.json({ ok: true, loan: publicLoan(l, true) });
});
app.delete('/api/loans/:id', needAdmin, (req, res) => {
  const i = db.loans.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, msg: '借条不存在' });
  db.loans.splice(i, 1);
  saveDb();
  res.json({ ok: true });
});

/* ================= 借款人公开端 ================= */
app.get('/api/p/:token', (req, res) => {
  const l = db.loans.find(x => x.token === req.params.token);
  if (!l) return res.status(404).json({ ok: false, msg: '未找到该借款记录，请核对链接' });
  res.json({ ok: true, loan: publicLoan(l, true) });
});
/* 借款人确认借条内容 */
app.post('/api/p/:token/confirm', (req, res) => {
  const l = db.loans.find(x => x.token === req.params.token);
  if (!l) return res.status(404).json({ ok: false, msg: '未找到借款记录' });
  if (l.confirmedAt) return res.json({ ok: true, msg: '已确认过' });
  l.confirmedAt = new Date().toISOString();
  saveDb();
  res.json({ ok: true });
});
/* 借款人提交还款凭证 */
app.post('/api/p/:token/pay', upload.single('voucher'), (req, res) => {
  const l = db.loans.find(x => x.token === req.params.token);
  if (!l) return res.status(404).json({ ok: false, msg: '未找到借款记录' });
  if (l.status === 'cancelled') return res.status(400).json({ ok: false, msg: '该借条已作废' });
  if (l.status === 'paid') return res.status(400).json({ ok: false, msg: '该笔借款已结清' });
  const method = String(req.body.method || '');
  if (!['wechat', 'alipay', 'bank', 'cash'].includes(method)) return res.status(400).json({ ok: false, msg: '请选择转账方式' });
  const amountCents = yuanToCents(req.body.amount);
  if (!amountCents || amountCents <= 0) return res.status(400).json({ ok: false, msg: '请填写转账金额' });
  const r = {
    id: crypto.randomBytes(8).toString('hex'),
    amountCents,
    method,
    ref: String(req.body.ref || '').trim(),
    note: String(req.body.note || '').trim(),
    voucher: req.file ? '/uploads/' + req.file.filename : null,
    voucherName: req.file ? req.file.originalname : null,
    submittedAt: new Date().toISOString(),
    confirmedAt: null,
    status: 'pending',
    confirmNote: ''
  };
  l.repayments.push(r);
  saveDb();
  res.json({ ok: true, repayment: { id: r.id }, msg: '提交成功，等待出借人确认到账' });
});

/* ================= 微信 Native 在线支付（借款人扫码，主动查单确认到账） ================= */
function wxCfg() { return wxpay.loadWxConfig(); }
function wxEnabled() { return !!wxCfg(); }
/** 生成商户订单号：JD + 时间戳 + 随机 */
function genOutTradeNo() {
  const d = new Date();
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return 'JD' + ts + crypto.randomBytes(3).toString('hex').toUpperCase();
}
/** 应还剩余（分）：本金+利息-已确认 */
function loanRemain(loan) {
  if (loan.status === 'paid' || loan.status === 'cancelled') return 0;
  return loan.amountCents + loanInterest(loan) - confirmedTotal(loan);
}
/** 依据订单主动查单 → 到账则登记还款记录（幂等） */
async function settleByOrder(order) {
  const cfg = wxCfg();
  if (!cfg) return { ok: false, msg: '在线支付未启用' };
  const q = await wxpay.queryOrder(cfg, order.outTradeNo);
  if (!q.ok || q.tradeState !== 'SUCCESS') return { ok: false, msg: q.msg || q.tradeState, tradeState: q.tradeState };
  // 幂等：该订单已结算 / 该微信交易号已入账
  if (order.status === 'paid') return { ok: true, done: true };
  const loan = db.loans.find(x => x.token === order.loanToken);
  if (!loan) return { ok: false, msg: '借条不存在' };
  const dup = (loan.repayments || []).some(r => r.wxTxnId && r.wxTxnId === q.transactionId);
  if (dup) { order.status = 'paid'; saveDb(); return { ok: true, done: true }; }
  const r = {
    id: crypto.randomBytes(8).toString('hex'),
    amountCents: q.amountCents || order.amountCents,
    method: 'wxpay', // 微信在线支付：自动确认到账
    ref: order.outTradeNo,
    note: '微信扫码在线支付（自动到账）',
    voucher: null, voucherName: null,
    wxTxnId: q.transactionId || '',
    submittedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    status: 'confirmed',
    confirmNote: '微信支付自动确认'
  };
  loan.repayments.push(r);
  order.status = 'paid';
  order.paidAt = r.confirmedAt;
  order.txnId = q.transactionId || '';
  if (confirmedTotal(loan) >= loan.amountCents + loanInterest(loan)) loan.status = 'paid';
  saveDb();
  return { ok: true, done: true, repaidYuan: centsToYuan(confirmedTotal(loan)) };
}

/* 1. 借款人发起在线支付：创建 Native 订单，返回 code_url 供页面生成二维码 */
app.post('/api/p/:token/wxpay', async (req, res) => {
  try {
    const cfg = wxCfg();
    if (!cfg) return res.status(400).json({ ok: false, msg: '在线支付未启用（出借人未配置微信商户）' });
    const l = db.loans.find(x => x.token === req.params.token);
    if (!l) return res.status(404).json({ ok: false, msg: '未找到借款记录' });
    if (l.status === 'cancelled') return res.status(400).json({ ok: false, msg: '该借条已作废' });
    if (l.status === 'paid') return res.status(400).json({ ok: false, msg: '该笔借款已结清' });
    if (!l.confirmedAt) return res.status(400).json({ ok: false, msg: '请先确认借条内容' });
    const amountCents = req.body.amountCents !== undefined
      ? Math.round(Number(req.body.amountCents))
      : loanRemain(l);
    const remain = loanRemain(l);
    if (!amountCents || amountCents <= 0) return res.status(400).json({ ok: false, msg: '金额无效' });
    if (amountCents > remain) return res.status(400).json({ ok: false, msg: `最多应还 ¥${centsToYuan(remain)}` });
    // 清掉该借条未支付的旧订单（防堆积）
    db.payOrders = db.payOrders.filter(o => !(o.loanToken === l.token && o.status !== 'paid'));
    const outTradeNo = genOutTradeNo();
    const notifyUrl = `${req.protocol}://${req.get('host')}/api/wxpay/notify`;
    const order = await wxpay.createNativeOrder(cfg, {
      outTradeNo,
      amountCents,
      description: `还款-${l.borrower.name}-${l.no}`,
      notifyUrl
    });
    if (!order.ok) return res.status(502).json({ ok: false, msg: order.msg || '下单失败' });
    db.payOrders.push({ outTradeNo, loanToken: l.token, loanId: l.id, amountCents, status: 'created', createdAt: new Date().toISOString(), paidAt: null, txnId: '' });
    saveDb();
    // 直接生成二维码 dataURL，页面免引入额外 JS
    const qr = await QRCode.toDataURL(order.codeUrl, { margin: 1, width: 480, color: { dark: '#16324f', light: '#ffffff' } });
    res.json({ ok: true, outTradeNo, codeUrl: order.codeUrl, qr, amountCents, remainYuan: centsToYuan(remain) });
  } catch (e) {
    const m = String(e.message || '');
    // 配置/密钥类错误统一为通用提示，避免向借款人暴露内部细节
    if (/DECODER|PEM|私钥|key|signature|certificate|HTTP \d+|超时/i.test(m) && !/微信下单失败/.test(m)) {
      console.error('[wxpay] 下单异常:', m);
      return res.status(502).json({ ok: false, msg: '在线支付暂时不可用，请改用线下转账方式，或联系出借人稍后重试' });
    }
    res.status(502).json({ ok: false, msg: m || '下单失败' });
  }
});

/* 2. 页面轮询：主动查单确认到账（最终依据，防伪） */
app.get('/api/p/:token/wxpay/status', async (req, res) => {
  try {
    const l = db.loans.find(x => x.token === req.params.token);
    if (!l) return res.status(404).json({ ok: false, msg: '未找到借款记录' });
    const outTradeNo = String(req.query.no || '');
    const order = db.payOrders.find(o => o.outTradeNo === outTradeNo && o.loanToken === l.token);
    if (!order) return res.status(404).json({ ok: false, msg: '订单不存在' });
    if (order.status === 'paid') {
      return res.json({ ok: true, state: 'paid', loan: publicLoan(l, true) });
    }
    const st = await settleByOrder(order);
    if (st.ok) return res.json({ ok: true, state: 'paid', loan: publicLoan(l, true) });
    return res.json({ ok: true, state: (st.tradeState || 'NOTPAY'), loan: publicLoan(l, true) });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

/* 3. 微信异步回调：解密后同样走主动查单（幂等） */
app.post('/api/wxpay/notify', async (req, res) => {
  const cfg = wxCfg();
  try {
    const resource = (req.body && req.body.resource) || {};
    let outTradeNo = '';
    if (cfg && resource.ciphertext) {
      try {
        const dec = wxpay.decryptNotify(cfg.apiV3Key, {
          ciphertext: resource.ciphertext,
          nonce: resource.nonce || '',
          associatedData: resource.associated_data || ''
        });
        outTradeNo = dec.out_trade_no || '';
        // 若回调标记交易成功，直接查单落账
        if (outTradeNo) {
          const order = db.payOrders.find(o => o.outTradeNo === outTradeNo);
          if (order && order.status !== 'paid') await settleByOrder(order);
        }
      } catch (e) { /* 解密失败忽略，靠轮询兜底 */ }
    }
    // 微信要求应答成功，否则重试轰炸
    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (e) {
    res.json({ code: 'SUCCESS', message: 'OK' });
  }
});

/* 还款链接二维码（管理端） */
app.get('/api/loans/:id/qrcode', needAdmin, async (req, res) => {
  const l = db.loans.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ ok: false, msg: '不存在' });
  const url = `${req.protocol}://${req.get('host')}/p/${l.token}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 640, color: { dark: '#16324f', light: '#ffffff' } });
    res.json({ ok: true, url, dataUrl });
  } catch (e) { res.status(500).json({ ok: false, msg: '二维码生成失败' }); }
});

/* 页面 */
app.get('/p/:token', (req, res) => {
  if (!db.loans.find(x => x.token === req.params.token)) return res.status(404).send('<h3 style="font-family:sans-serif;text-align:center;margin-top:20vh">未找到该借款记录，请核对链接是否正确</h3>');
  res.sendFile(path.join(__dirname, 'public', 'repay.html'));
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.redirect('/admin'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => console.log(`[借条] http://localhost:${PORT}`));
