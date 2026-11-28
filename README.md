# 照护托付中的代理权生效与定向付款

本仓库保存该业务的合成登记资料、原始变更资料、受托付款机构的本地协议服务，以及养老托付业务后端。所有机构、人员、金额和文书均为虚构，不连接真实业务系统，也不作真实监护资格或医疗诊断认定。

## 运行环境

使用 Node.js 22.23.4。没有第三方 npm 依赖，package-lock.json 锁定当前依赖清单。

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run start:partner   # 终端 1：受托付款合作方，默认 4317
npm start               # 终端 2：养老托付业务应用，默认 4318
npm run scenario        # 一键综合演练（接替与暂停相遇的完整处理）
```

## 业务应用

业务应用（`src/`）默认监听 4318 端口，`GET /health` 可查询存活状态。`PORT` 更换端口，`APP_STATE` 指定持久状态文件（默认 `.local/app.json`），`PARTNER_URL` 指定合作方地址（默认 `http://127.0.0.1:4317`），`APP_DATE` 可固定演练日历日。停止进程后用同一状态文件启动会保留全部业务流水；删除状态文件即回到仅含合成基础资料的初始状态。

业务应用把付款指令送达合作方的 `/trust/draws`：合作方 `accepted` 仅表示收件受理，`confirmed`/`returned` 才是终态；受托方未给终态前，业务侧指令保留"待核实"。完整接口与工作人员操作步骤见 [docs/usage.md](docs/usage.md)。

关键业务约束均由领域逻辑强制：

- 老人意思表示、代理权生效、实际照护服务是三类独立事实；备用代理须经独立见证确认才能接替，提交人不能自行确认；
- 监察暂停与付款受理、代理接替可同时发生：已支付不改写，未支付按暂停范围与新代理权限重新决定；
- 安排照护不等于允许付款，付款另受资金用途、周期额度、收款方利益冲突、暂停范围和验收结果约束；
- 争议部分不挤占基本照护额度，跨月服务按各期实际占用归集，服务商更换期不得重叠报销；
- 各角色只能看到获准范围，单次照护请求可经 `GET /trace/:serviceId` 追溯授权、交付与付款。

## 合作方服务

合作方默认监听 4317 端口，GET /health 可查询存活状态。PORT 可更换端口，PARTNER_STATE 可指定持久状态文件，默认 .local/partner.json。停止进程后用同一状态文件启动会保留合作方流水。

也可以使用 Docker 启动合作方：

```bash
docker build -t elder-entrustment:local .
docker run --rm -p 4317:4317 elder-entrustment:local
```

容器要保留状态时，将可写目录挂载到 /app/.local；该目录需允许容器 node 用户写入。测试使用临时目录与随机本地端口，可独立运行。

## 资料

fixtures/records.json 是业务原始资料，sourceChanges 保存后续收到的变更或申请，均没有自动导入成已批准决定；业务应用启动时只把 elders/actors/providers/trusts 作为基础合成资料载入，serviceDrafts 与 sourceChanges 仍保留为待办参考。fixtures/relations.json 声明登记资料的关联字段，docs/data.md 解释计量和身份语义。fixtures/partner.json 定义合作方接口名称及字段。support/peer.mjs 提供合作方行为，docs/partner.md 是实际协议；src/ 是业务后端，docs/usage.md 是中文使用说明；tests 检查资料关系、合作方协议、业务领域规则与 HTTP 集成。
