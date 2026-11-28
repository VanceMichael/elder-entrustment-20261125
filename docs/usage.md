# 工作人员使用说明（本地合成演练）

本系统用于养老托付业务的**本地演练**：老人在清醒时登记分事项委托意愿，服务机构提交照护安排，独立见证人员确认文书与生效材料，资金受托方按已获准用途付款，监察人员可暂停有争议的支出。

> 所有人员、机构、金额、文书均为本地合成的虚构资料。系统**不作真实监护资格或医疗诊断认定**，只登记各角色在演练中的决定与依据。

## 一、启动与登录

需要两个进程：受托付款合作方（4317）与业务应用（4318）。

```bash
npm ci --ignore-scripts
npm run start:partner     # 终端 1：合作方受托付款服务
npm start                 # 终端 2：养老托付业务应用
```

业务应用默认把状态写入 `.local/app.json`，删除该文件即可重置演练数据。可用环境变量调整：`PORT`（端口）、`APP_STATE`（状态文件）、`PARTNER_URL`（合作方地址）、`APP_DATE`（演练日历日，格式 YYYY-MM-DD）。

所有写接口都需要先登录换取本机令牌，后续请求带头 `X-Auth-Token`：

```bash
curl -s localhost:4318/auth/login -H 'Content-Type: application/json' -d '{"actorId":"elder-1"}'
```

合成账号（见 `fixtures/records.json`，服务商账号由系统按机构自动生成）：

| actorId | 角色 | 能做什么 |
| --- | --- | --- |
| `elder-1` | 老人本人 | 登记委托意愿、提交材料、在可自决时决定安排 |
| `agent-a` / `agent-b` | 前位 / 备用代理 | 在任且事项在范围内时批准安排、验收交付 |
| `witness` | 独立见证人员 | 确认生效材料（不能确认自己提交的材料） |
| `supervisor` | 监察人员 | 暂停/解除支出、查决定依据、转介材料，不能下单 |
| `trustee` | 资金受托方 | 受理费用申请、生成与送达付款指令、核对终态 |
| `sp-1-account` / `sp-2-account` | 服务机构 SP-1 / SP-2 | 提交安排、登记交付、就本机构服务申请费用 |

## 二、三类事实必须分开

系统把三件事作为不同对象保存，不能互相替代：

1. **老人的意思表示**——`POST /mandates` 登记的委托意愿（事项范围、适用时间、代理顺序），状态先是 `registered`，不代表代理权已生效。
2. **代理权的生效**——材料经 `POST /evidence` 提交后，由见证人 `POST /capacity/decisions` 独立确认，代理才取得权限。
3. **实际照护服务**——服务商的安排、交付与验收，以及后续费用和付款。

委托可只涵盖 `daily-care`（生活照料）、`escort`（医疗陪护）、`designated-expense`（指定费用），并带 `validFrom`/`until` 适用时间与前位、备用代理顺序。

## 三、日常操作流程

### 1. 老人登记委托意愿

```bash
curl -s localhost:4318/mandates -H "X-Auth-Token: $TOK_ELDER" -H 'Content-Type: application/json' -d '{
  "elder":"EL-1","scopes":["daily-care","escort"],
  "primary":"agent-a","backup":"agent-b",
  "validFrom":"2026-11-01","until":"2027-01-31"}'
```

### 2. 代理权生效与备用代理接替

- 代理或其他方向 `POST /evidence` 提交生效材料（如 `activation-request`）。
- 见证人 `POST /capacity/decisions`，`decision` 取 `confirm`（确认前位不能履职）、`conflict`（材料矛盾）、`recovered`（老人恢复自决），并在 `evidenceIds` 中引用材料。
- **提交人不能自行确认**；备用代理不能自己"点一下"取得权限，必须有前位不能履职的材料并经见证人 `confirm`。
- 查当前谁能决定哪件事：`GET /authority/EL-1`、`GET /decisions/EL-1`。

### 3. 录入新的照护服务

```bash
# 服务商提交安排
curl -s localhost:4318/services -H "X-Auth-Token: $TOK_SP1" -H 'Content-Type: application/json' -d '{
  "elder":"EL-1","purpose":"daily-care",
  "start":"2026-12-05","end":"2026-12-10","dailyMinor":5000}'
# 老人本人或在任代理批准（按当前决定权）
curl -s localhost:4318/services/SVC-xxxx/decision -H "X-Auth-Token: $TOK_AGENT" -H 'Content-Type: application/json' -d '{"approve":true}'
# 服务商逐日登记交付，再由有权决定者验收（服务商不能验收自己的交付）
curl -s localhost:4318/deliveries -H "X-Auth-Token: $TOK_SP1" -H 'Content-Type: application/json' -d '{"service":"SVC-xxxx","date":"2026-12-05","proof":"护理记录"}'
curl -s localhost:4318/deliveries/DLV-xxxx/acceptance -H "X-Auth-Token: $TOK_AGENT" -H 'Content-Type: application/json' -d '{"accepted":true}'
```

更换服务商时用 `POST /services/replacement`（字段同 `/services`），系统会登记被接替的原服务；旧商未结清的有效服务保留，但同一日历日不能由两家重叠报销。

### 4. 费用申请与定向付款

```bash
# 服务商就已验收交付申请（跨月自动按月拆分成各期实际占用）
curl -s localhost:4318/fee-requests -H "X-Auth-Token: $TOK_SP1" -H 'Content-Type: application/json' -d '{"service":"SVC-xxxx"}'
# 受托方生成付款指令：不合规的为 blocked 并写明原因，不占额度
curl -s localhost:4318/fee-requests/FEE-xxxx/instructions -X POST -H "X-Auth-Token: $TOK_TRUSTEE"
# 送达合作方；再用 /sync 核对合作方终态
curl -s localhost:4318/payments/PAY-xxxx/dispatch -X POST -H "X-Auth-Token: $TOK_TRUSTEE"
curl -s localhost:4318/payments/PAY-xxxx/sync     -X POST -H "X-Auth-Token: $TOK_TRUSTEE"
curl -s localhost:4318/payments/PAY-xxxx          # 查钱为什么能付或被挡住
```

付款的五道约束（任一不满足即 `blocked`，原因写入 `blockReasons`）：

1. 资金委托用途涵盖该事项；
2. 收款方不在 `forbiddenPayees` 利益冲突名单（代理不能给自己付款）；
3. 不在监察暂停范围内；
4. 当月已占用额度 + 本笔不超过 `monthlyLimitMinor`（争议部分不挤占基本照护额度）；
5. 对应交付已验收通过，且服务商更换期无同日重叠报销。

合作方 `accepted` 只表示收件受理，不代表到账或责任解除；`confirmed`/`returned` 才是终态。受托方尚未给出终态的指令一律保持 `pending-verification`（待核实）。

### 5. 监察暂停与重新评估

```bash
# scopeType：service（某项服务）/ provider（某机构）/ scope（某事项用途）
curl -s localhost:4318/pauses -H "X-Auth-Token: $TOK_SUP" -H 'Content-Type: application/json' -d '{
  "elder":"EL-1","scopeType":"provider","scopeRef":"SP-1","reason":"交付证明争议"}'
# 暂停相遇后，对未支付指令重新决定（已受理/已支付的不会被改写）
curl -s localhost:4318/payments/PAY-xxxx/reevaluate -X POST -H "X-Auth-Token: $TOK_TRUSTEE"
# 争议核实后解除
curl -s localhost:4318/pauses/PSP-xxxx/lift -X POST -H "X-Auth-Token: $TOK_SUP" -H 'Content-Type: application/json' -d '{"reason":"核实完毕"}'
```

### 6. 服务取消（款项可能已送达）

带 `"checkPartner":true` 调用取消接口，系统会先逐笔查询合作方是否受理：

```bash
curl -s localhost:4318/services/SVC-xxxx/cancel -H "X-Auth-Token: $TOK_AGENT" -H 'Content-Type: application/json' \
  -d '{"reason":"家属调整","checkPartner":true}'
```

- 已受理/已支付：保留事实，不能作未发生，也不能同时退款、再支付或把额度恢复为可花余额，须等合作方 `returned` 终态（`POST /payments/PAY-xxxx/return`）后才释放额度。
- 未支付/受阻：指令转为 `cancelled-unpaid`，未明额度不恢复。

### 7. 矛盾材料与老人恢复自决

- 见证人 `decision:"conflict"` 并给 `disputedScopes`：争议事项暂停代办，未争议的日常服务继续。
- 见证人 `decision:"recovered"`：老人恢复自行决定，新申请以本人有效意愿为准；**此前代理合法履职的记录不会被抹去**（见 `GET /events`）。

## 四、查询与追溯

| 接口 | 用途 |
| --- | --- |
| `GET /authority/EL-1` | 当前决定权、在任代理、暂停事项与原因 |
| `GET /decisions/EL-1` | 目前谁可以决定哪件事 |
| `GET /continuation/EL-1` | 哪些服务可继续、哪些被暂停或取消 |
| `GET /payments/PAY-xxxx` | 钱为什么能付或被挡住、额度快照、处理历史 |
| `GET /quota/EL-1` | 各周期额度占用与可用余额 |
| `GET /trace/SVC-xxxx` | 按一次照护请求追溯授权、交付、费用、付款与事件链 |
| `GET /me/view` | 按登录身份过滤后的可见范围 |
| `GET /events` | 全量事件流（服务商不可用） |

可见范围：老人与代理只能看到获准范围；服务商只能查看自己提供的服务和应收；监察可查决定依据但不能冒充老人下单；见证人不开放资金流水。

## 五、一键本地核验

不用手工逐条调用，直接运行综合演练（进程内自动启动合作方与业务应用，结束即清理临时状态）：

```bash
npm run scenario
```

该演练按时间顺序覆盖：意愿登记 → 代理生效 → 安排批准与验收 → 受理付款与终态同步 → 争议交付 → **监察暂停与备用代理接替同时发生** → 重新评估 → 合作方 pending/断线受理 → 服务商更换与重叠报销拦截 → 在途取消（已支付不改写、未支付重决定、退回后释放额度）→ 矛盾材料部分暂停 → 老人恢复自决 → 可见范围与全链路追溯。任一步断言失败，进程以非零码退出。

## 六、接口速览

```
POST   /auth/login
POST   /mandates                GET  /mandates
POST   /evidence                POST /capacity/decisions
GET    /authority/:elderId      GET  /decisions/:elderId
POST   /services                POST /services/replacement       GET /services
POST   /services/:id/decision   POST /services/:id/cancel
POST   /deliveries              POST /deliveries/:id/acceptance
POST   /fee-requests            GET  /fee-requests
POST   /fee-requests/:id/instructions
POST   /payments/:id/dispatch   POST /payments/:id/sync
POST   /payments/:id/reevaluate POST /payments/:id/return
GET    /payments/:id            GET  /payments                    GET /quota/:elderId
POST   /pauses                  POST /pauses/:id/lift            GET /pauses
GET    /continuation/:elderId   GET /trace/:serviceId
GET    /me/view                 GET /events
```

错误码：400 资料不符、401 未认证、403 无权限/无权决定、404 对象不存在、409 状态或资料冲突。
