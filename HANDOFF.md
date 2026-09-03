# 好友借条平台 — Agent 交接文档

> 生成时间：2026-09-03 11:50
> 更新时间：2026-09-03 12:25（v4 还款打卡确认已完成）
> 当前版本：**v4**（v2 多用户版 + v3 实名材料/手写借条 + v4 还款打卡确认）
> 在线地址：**https://pay.hhtc.top**

---

## 一、产品定位（必须记住）

**这不是 P2P 借贷平台**，是**自然人之间一对一的借条辅助工具**，法律边界极关键：

| 红线 | 当前实现 |
|---|---|
| 平台不经手资金 | 收款码由每个用户自己上传，借条页展示双方各自的收款方式，钱直接两人之间转 |
| 平台不核验借条真假 | 借条内容由用户填写，平台仅生成模板 |
| 利率用户自定 | 系统**不拦截**，但 >LPR4 倍时必须勾选"已知悉风险"才放行；前端红字动态提示当期 LPR4 值 |
| 隐私合规 | 身份证照片存私有目录 `data/uploads_id`，绝不走公开静态路由；公开视图只展示脱敏 ID（310\*\*\*\*\*\*\*0011） |

---

## 二、技术栈

| 层 | 技术 |
|---|---|
| 语言 | Node.js 22 + Express 4 |
| 存储 | JSON 文件（`data/db.json`，原子写：先写 tmp 再 rename） |
| 上传 | multer（收款码存公开 `/uploads`，实名/手写借条存私有 `data/uploads_id`） |
| 二维码 | qrcode |
| 鉴权 | HMAC-SHA256 cookie（`iou_s`），密码 scrypt 哈希 |
| 进程 | PM2（进程名 `loan-pay`，端口 8901） |
| 反向代理 | nginx sites-enabled/pay.hhtc.top → localhost:8901 |
| HTTPS | certbot（证书自动续期） |
| 备份 cron | 每天 03:30 tar `/opt/<your-project-path>/data` → `/opt/backups/loan-pay-YYYYMMDD.tar.gz`，保留 30 天 |

---

## 三、项目结构

```
<project-root>/
├── server.js          # 主服务（700+行）
├── package.json       # 依赖：express、multer、qrcode
├── .gitignore         # ⚠️ 必须保留（含 uploads_id/、.workbuddy/ 等）
├── public/
│   ├── index.html     # 首页（入口 + 功能说明）
│   ├── auth.html      # 登录/注册页
│   ├── u.html         # 用户个人中心 SPA（核心页面）
│   └── pub.html       # 公开借条页（免登录查看，引导确认）
├── data/
│   ├── db.json        # 数据库（Git忽略）
│   ├── uploads/       # 收款码/凭证（公开可访问）
│   └── uploads_id/    # ⚠️ 实名照片/手写借条（私有，禁止进Git）
└── screenshots/       # 本地测试截图（Git忽略）
```

**服务器路径**：部署时自行选择（如 `/opt/<your-project-path>/`，结构与本地一致，db.json 在服务器本地）

---

## 四、数据模型

### users
```js
{
  id: 'hex8',           // crypto.randomBytes(8)
  phone: '13xxxxxxxxx',
  name: '张三',
  idcard: '310101199001011234',
  passwordHash: 'hex...',
  salt: 'hex16',
  payQr: {              // 用户自己的收款方式（各填各的）
    wechatImg: '/uploads/xxx.jpg',
    alipayImg: '/uploads/yyy.jpg',
    bank: '工商银行 6222...'
  },
  idPhotos: {           // 实名材料（私有存储路径）
    handheld: 'id-xxx.jpg',
    front: 'id-xxx.jpg',
    back: 'id-xxx.jpg'
  },
  createdAt: 'ISO string'
}
```

### loans
```js
{
  id: 'hex8',
  no: 'JT-20260903-1001',   // 唯一编号
  token: 'hex12',            // 公开链接用
  lenderId: 'hex8',          // 关联 users.id
  borrower: { name, phone, idcard },
  amountCents: 5000000,      // 分，整数运算
  ratePct: 8,                // 年利率百分比（自由填）
  startDate: '2026-09-03',
  endDate: '2026-12-03',
  repayMethod: 'lump|monthly_interest|equal_installment',
  purpose: '', note: '',
  rateOverLpr4: true/false,  // 是否超LPR4
  riskAck: true/false,       // 用户是否勾选风险确认
  status: 'pending|confirmed|paid|cancelled|rejected',
  confirmAt: 'ISO', confirmName: '',
  rejectNote: '',
  repayments: [],            // 还款记录（v4 起含 scheduleIdx/confirmedBy/confirmedAt）
  evidence: [],              // 手写借条照片
  createdAt: 'ISO'
}
```

### repayments（还款记录 · v4 起）
```js
{
  id: 'hex8',
  amountCents: 33333,
  scheduleIdx: 1,            // v4 新增：第几期打卡（0=不指定）
  method: 'wechat|alipay|bank|cash',
  ref: '转账流水号',
  note: '',
  voucher: '/uploads/xxx.jpg',   // 转账凭证
  voucherName: '',
  submittedAt: 'ISO',
  confirmedAt: 'ISO|null',   // v4 起：驳回也记录时间
  status: 'pending|confirmed|rejected',
  confirmedBy: '',           // v4 新增：出借人姓名
  confirmNote: ''
}
```

### evidence（手写借条照片）
```js
{
  id: 'hex8',
  filename: 'id-xxx.jpg',       // 存ID_DIR
  name: 'original.jpg',
  uploadedBy: 'lender|borrower',
  uploadedByUserId: 'hex8',
  uploadedAt: 'ISO'
}
```

---

## 五、API 接口清单

### 认证
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/register | 注册（手机号+密码+姓名+身份证+协议勾选） |
| POST | /api/auth/login | 登录（设置 iou_s cookie） |
| POST | /api/auth/logout | 退出 |
| GET | /api/me | 获取当前用户（含 idPhotos 状态） |

### 用户设置
| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | /api/me/profile | 更新姓名/身份证 |
| GET | /api/me/payqr | 获取收款方式 |
| PUT | /api/me/payqr | 更新收款方式 |
| POST | /api/me/payqr/upload | 上传收款码图片（type=wechat/alipay） |
| POST | /api/me/idphotos | 上传实名材料（type=handheld/front/back） |
| GET | /api/me/idphotos/:type | 查看自己的实名照片 |

### 借条
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/loans/mine | 我的借条（asLender + asBorrower） |
| POST | /api/loans | 创建借条（定向发借款人手机号） |
| GET | /api/loans/:id | 查看单条借条详情 |
| PUT | /api/loans/:id | 修改待确认/被驳回的借条 |
| POST | /api/loans/:id/confirm | 借款人确认借款 |
| POST | /api/loans/:id/reject | 借款人驳回 |
| POST | /api/loans/:id/cancel | 出借人作废 |

### 还款（v4 增强）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/loans/:id/repay | 借款人提交还款（金额+凭证+**scheduleIdx**） |
| POST | /api/loans/:id/repay/:rid/confirm | 出借人打卡确认收到 |
| POST | /api/loans/:id/repay/:rid/reject | 出借人驳回 |

### 证据/材料
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/loans/:id/evidence | 上传手写借条照片（最多9张） |
| GET | /api/loans/:id/evidence/:eid | 查看某张照片 |
| DELETE | /api/loans/:id/evidence/:eid | 删除自己的照片 |
| GET | /api/loans/:id/idphoto/:who/:type | 查看对方实名材料（双方互看） |

### 公开页（免登录）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/p/:token | 公开借条详情（身份证脱敏，无idPhotos/evidence） |
| GET | /api/loans/:id/calendar | 导出 .ics 日历文件 |
| GET | /api/loans/:id/qrcode | 生成借条分享二维码 |

### 页面路由
| 路径 | 说明 |
|---|---|
| / | 首页 |
| /auth | 登录/注册 |
| /u | 个人中心 SPA |
| /u/* | 个人中心子路由 |
| /p/:token | 公开借条页 |
| /admin、/repay | 旧路径 302 跳 /auth（v1残留兼容） |

---

## 六、前端 SPA 路由（u.html）

`/u` 页面通过 hash 路由切换视图：
- `/u` — 概览（我借出的 / 我借入的 两个 tab，**v4 起列表含「待打卡」提示条**）
- `/u#/create` — 创建借条
- `/u#/loan/:id` — 借条详情（含确认、还款、证据、实名材料查看；**v4 起还款计划按期显示「已打卡/部分/逾期」，还款记录改双步时间线**）
- `/u#/settings` — 设置（个人信息、收款码、实名材料上传）

---

## 七、已上线功能 ✅

1. 多用户注册/登录（手机号唯一）
2. 借条创建 + 定向发给借款人（匹配手机号）
3. 借款人「确认借款」按钮 → 双方达成合意
4. 还款计划三方式（一次性/按月付息/等额本息）
5. 一键下载 .ics 日历文件导入手机提醒
6. Canvas 生成借条长图（可保存发微信）
7. 双方实名认证材料上传与查看（手持/人像面/国徽面）
8. 手写借条照片上传与查看（最多9张，双方各自管理）
9. 身份证脱敏展示（公开视图 310\*\*\*\*\*\*\*0011）
10. 全站免责声明 + 利率 LPR4 红字提示
11. 生成 QR 二维码分享借条
12. 生产部署 + 每日备份 cron
13. **还款打卡确认（v4）**：每笔还款带期数（scheduleIdx）；出借人点「打卡确认收到」才入账；还款计划按期展示已打卡/部分/逾期；双方视角均有「① 提交打卡 ② 确认收到」时间线；提交还款时选期数，金额按所选期自动联动

---

## 八、本次新增需求（还款打卡确认）✅ 已完成（commit dfa61f3）

**用户需求原话**：
> 每一次还款要让 还款人提交还款金额 出借人 要在网站上点击收到确认 形成打卡确认形式

**改造方向（已全部落地）**：
1. ✅ 在 `repayments` 加 `scheduleIdx` 字段（整数，对应 schedule[idx-1]）
2. ✅ 前端"我借出的"列表里，pending 状态的还款用醒目卡片展示（橙色待确认提示条 + 详情页橙色高亮卡片 + 「打卡确认收到」按钮）
3. ✅ 出借人确认后，还款人个人中心同步显示「已收到」状态
4. ✅ 加「还款确认时间线」：借款人提交打卡 → 出借人确认收到

**实现要点**：
- 还款分配算法 `applyPaid`：先按 `scheduleIdx` 定向打卡，溢出与未指定期次按 `confirmedAt` 时间顺序瀑布式抵扣最早未还期
- 顺带修既有 bug：原 `buildSchedule` 中 `paidCents: 0` 写死，导致还款计划表「状态」列永远显示「待还」，现已接通真实打卡数据
- 三层验证：自动化结构校验（标签平衡 + 内联脚本语法）→ 浏览器渲染验证（agent-browser + snapshot）→ 截图肉眼确认

---

## 九、开发约束与注意事项

### 强制规则
1. **严禁把 `data/uploads_id/` 或 `.workbuddy/` 提交到 Git**（已有 git-commit-safety-check skill 强制扫描）
2. **身份证照片永远不经过公开静态路由**，只能通过带登录校验的 API 访问
3. **金额一律用分（整数）**，人民币元只在展示时转换
4. **db.json 原子写**：先 `writeFileSync(tmp)` 再 `renameSync`，避免并发写入损坏
5. **Edit 工具偶发'成功但未持久化'**：使用 Edit 工具后若 grep 验证发现改动未生效，立即改用 Python str.replace 绕过（已实测可复现，备用方案可靠）
6. **HANDOFF.md 等含敏感运维信息（服务器 IP/SSH user/部署路径）的文档，入仓前必须脱敏**

### 已知踩坑点
- HTML 内联 script 里的 `?` 三元运算符在 `replace` 里要格外小心引号（已发生过 bug）
- 千分位正则用 `\B(?=(\d{3})+(?!\d))`，不要用 `(?!\\.)` 会导致小数错位
- 浏览器 `agent-browser` 操作时，URL 含 `?` 必须加引号，否则 zsh 会展开

### 颜色/设计系统
- 主色：深蓝 `#16324f`（金融感）
- 成功：`#22c55e`，警告：`#f59e0b`，危险：`#ef4444`
- 卡片圆角 12px，阴影 subtle，移动端优先

---

## 十、服务器运维（示例命令，请按实际部署环境替换）

```bash
# 查看服务状态（替换为你的 SSH user 与服务器 IP）
ssh <ssh-user>@<your-server-ip> "pm2 list | grep loan-pay"

# 查看日志
ssh <ssh-user>@<your-server-ip> "pm2 logs loan-pay --lines 20 --nostream"

# 重启
ssh <ssh-user>@<your-server-ip> "cd /opt/<your-project-path> && pm2 restart loan-pay"

# 恢复最新备份
ssh <ssh-user>@<your-server-ip> "tar xzf /opt/backups/loan-pay-\$(ls -t /opt/backups/ | head -1) -C /opt/<your-project-path> data/"

# 测试 HTTPS
curl -s -o /dev/null -w '%{http_code}' https://<your-domain>/
```

部署步骤（rsync 同步）：
```bash
# 本地 → 服务器
rsync -avz --exclude='data/' --exclude='.git/' --exclude='screenshots/' \
  ./server.js ./public/ <ssh-user>@<your-server-ip>:/opt/<your-project-path>/
ssh <ssh-user>@<your-server-ip> "cd /opt/<your-project-path> && pm2 restart loan-pay"
```

---

## 十一、GitHub 仓库

- 仓库地址：`<your-github-repo-url>`（如 `git@github.com:your-name/your-repo.git`）
- 分支：`main`
- ⚠️ **仓库里没有敏感文件**（uploads_id、.workbuddy、db.json、HANDOFF.md 内的服务器 IP 等均已脱敏或忽略）