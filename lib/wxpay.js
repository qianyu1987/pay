'use strict';
/**
 * 微信支付 APIv3 Native — Node 实现（零第三方依赖）
 * 复用自彩票站已验证模式：RSA-SHA256 签名下单 + 主动查单确认 + 回调解密
 * 安全模型：以「主动查单」(商户私钥签名请求微信) 为最终确认依据，防伪造回调
 */
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const fs = require('fs');

const API_BASE = 'https://api.mch.weixin.qq.com';
const WXPAY_FILE = path.join(__dirname, '..', 'data', 'wxpay.json');

/* ---------------- 配置加载（data/wxpay.json，缺失返回 null → 在线支付不可用） ---------------- */
function loadWxConfig() {
  try {
    if (!fs.existsSync(WXPAY_FILE)) return null;
    const c = JSON.parse(fs.readFileSync(WXPAY_FILE, 'utf8'));
    const w = c.wechat || c;
    if (!w.mch_id || !w.app_id || !w.api_v3_key || !w.serial_no || !w.private_key) return null;
    return {
      mchId: w.mch_id,
      appId: w.app_id,
      apiV3Key: w.api_v3_key,
      serialNo: w.serial_no,
      privateKey: w.private_key
    };
  } catch (e) { return null; }
}

/* ---------------- 签名 ---------------- */
function buildSignStr(method, urlPath, timestamp, nonce, body) {
  return `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body || ''}\n`;
}
function rsaSign(signStr, privateKeyPem) {
  return crypto.createSign('RSA-SHA256').update(signStr).sign(privateKeyPem).toString('base64');
}
function authHeader(cfg, method, urlPath, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const signStr = buildSignStr(method, urlPath, timestamp, nonce, body || '');
  const signature = rsaSign(signStr, cfg.privateKey);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${cfg.serialNo}",signature="${signature}"`;
}

/* ---------------- HTTPS 请求 ---------------- */
function httpsReq(options, bodyBuf, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 非JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), json });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('微信API请求超时')); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/* ---------------- Native 下单 ---------------- */
async function createNativeOrder(cfg, { outTradeNo, amountCents, description, notifyUrl }) {
  const urlPath = '/v3/pay/transactions/native';
  const body = JSON.stringify({
    appid: cfg.appId,
    mchid: cfg.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: amountCents, currency: 'CNY' }
  });
  const r = await httpsReq({
    hostname: 'api.mch.weixin.qq.com',
    path: urlPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(cfg, 'POST', urlPath, body),
      'User-Agent': 'LoanPay/1.0 (Node)'
    }
  }, Buffer.from(body, 'utf8'));
  if (r.status >= 200 && r.status < 300 && r.json && r.json.code_url) {
    return { ok: true, codeUrl: r.json.code_url, outTradeNo };
  }
  const msg = (r.json && (r.json.message || r.json.code)) || r.body || `HTTP ${r.status}`;
  throw new Error(`微信下单失败: ${msg}`);
}

/* ---------------- 主动查单 ---------------- */
async function queryOrder(cfg, outTradeNo) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${cfg.mchId}`;
  const r = await httpsReq({
    hostname: 'api.mch.weixin.qq.com',
    path: urlPath,
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: authHeader(cfg, 'GET', urlPath, '') }
  });
  if (r.status === 200 && r.json) {
    return {
      ok: true,
      tradeState: r.json.trade_state || 'UNKNOWN',
      transactionId: r.json.transaction_id || '',
      amountCents: (r.json.amount && r.json.amount.total) || 0,
      paidAt: r.json.success_time || null
    };
  }
  const msg = (r.json && r.json.message) || r.body || `HTTP ${r.status}`;
  return { ok: false, tradeState: 'ERROR', msg };
}

/* ---------------- 回调数据解密（AES-256-GCM，key=api_v3_key） ---------------- */
function decryptNotify(apiV3Key, { ciphertext, nonce, associatedData }) {
  const buf = Buffer.from(ciphertext, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', apiV3Key, nonce);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(associatedData || '', 'utf8'));
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

module.exports = { loadWxConfig, createNativeOrder, queryOrder, decryptNotify, WXPAY_FILE };
