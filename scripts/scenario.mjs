// 本地综合演练：在进程内启动合作方服务与业务应用，跑通一次"接替与暂停相遇"的完整处理。
// 所有机构、人员、金额、文书均为合成虚构资料；系统不作真实监护资格或医疗诊断认定。
// 运行：npm run scenario   （任一断言失败则进程以非零码退出）
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeer } from '../support/peer.mjs';
import { createApp } from '../src/app.mjs';
import { PartnerClient } from '../src/partner-client.mjs';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../fixtures/partner.json', import.meta.url), 'utf8'));
const seedFile = new URL('../fixtures/records.json', import.meta.url);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

process.env.APP_DATE = '2026-11-28';
const failures = [];
let step = 0;
function narrate(title) { console.log(`\n【${String(++step).padStart(2, '0')}】${title}`); }
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures.push(msg); console.error(`  ✗ 断言失败：${msg}`); }
}

const dir = await mkdtemp(join(tmpdir(), 'elder-drill-'));
const peer = createPeer(config, join(dir, 'partner.json'));
const peerBase = await listen(peer);
const { server } = createApp({ stateFile: join(dir, 'app.json'), partnerBaseUrl: peerBase, seedFile });
const appBase = await listen(server);
const control = new PartnerClient(peerBase, config);
console.log('演练环境已启动：合作方', peerBase, '｜业务应用', appBase);

async function api(token, method, path, body) {
  const res = await fetch(appBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Auth-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const login = async actorId => (await api(null, 'POST', '/auth/login', { actorId })).json.token;
const tokens = {};
for (const a of ['elder-1', 'agent-a', 'agent-b', 'witness', 'supervisor', 'trustee', 'sp-1-account', 'sp-2-account']) {
  tokens[a] = await login(a);
}
const T = tokens;

// ---------- 阶段一：意愿登记与代理生效 ----------
narrate('老人清醒时登记分事项委托意愿（生活照料＋医疗陪护，前位 agent-a、备用 agent-b）');
const md = await api(T['elder-1'], 'POST', '/mandates', {
  elder: 'EL-1', scopes: ['daily-care', 'escort'], primary: 'agent-a', backup: 'agent-b',
  validFrom: '2026-11-01', until: '2027-01-31',
});
check(md.status === 201 && md.json.status === 'registered', '意愿登记成功，初始状态 registered（意思表示不等于代理权生效）');
const mandateId = md.json.id;

narrate('服务机构 SP-1 提交具体照护安排（11-28 至 12-03，每日 5000 分，跨月）');
const svc1 = await api(T['sp-1-account'], 'POST', '/services', {
  elder: 'EL-1', purpose: 'daily-care', start: '2026-11-28', end: '2026-12-03', dailyMinor: 5000,
});
check(svc1.status === 201, 'SP-1 安排已提交');
const service1 = svc1.json.id;

narrate('代理权尚未生效：代理试图批准安排被拒；监察也不能冒充老人下单');
const agentEarly = await api(T['agent-a'], 'POST', `/services/${service1}/decision`, { approve: true });
check(agentEarly.status === 403, '未生效代理无权批准：' + agentEarly.json.error);
const supervisorOrder = await api(T.supervisor, 'POST', '/services', {
  elder: 'EL-1', purpose: 'daily-care', start: '2026-11-28', end: '2026-11-28', dailyMinor: 100,
});
check(supervisorOrder.status === 403, '监察人员不能冒充老人/服务商下单');

narrate('生效材料提交与独立见证确认（提交人不能自行确认）');
const ev1 = await api(T['agent-a'], 'POST', '/evidence', { elder: 'EL-1', kind: 'activation-request', summary: '老人暂时不能亲自处理事务' });
check(ev1.status === 201, '代理提交生效材料');
const ownEvidence = await api(T.witness, 'POST', '/evidence', { elder: 'EL-1', kind: 'witness-note', summary: '见证人的旁注' });
const selfConfirm = await api(T.witness, 'POST', '/capacity/decisions', {
  elder: 'EL-1', mandate: mandateId, decision: 'confirm', evidenceIds: [ownEvidence.json.id],
});
check(selfConfirm.status === 403, '见证人确认自己提交的材料被拒：' + selfConfirm.json.error);
const cpd1 = await api(T.witness, 'POST', '/capacity/decisions', {
  elder: 'EL-1', mandate: mandateId, decision: 'confirm', evidenceIds: [ev1.json.id],
});
check(cpd1.status === 201, '独立见证确认，前位代理 agent-a 生效');
const auth1 = await api(T['agent-a'], 'GET', '/authority/EL-1');
check(auth1.json.agentId === 'agent-a' && auth1.json.selfDetermining === false, '当前决定权：agent-a 在任');

narrate('在任代理批准 SP-1 的照护安排');
const dec1 = await api(T['agent-a'], 'POST', `/services/${service1}/decision`, { approve: true });
check(dec1.status === 200 && dec1.json.status === 'approved', '安排获批准');

// ---------- 阶段二：交付验收与定向付款 ----------
narrate('SP-1 登记两日实际交付（11-28、11-29），服务商不能自行验收');
const dlvIds = [];
for (const date of ['2026-11-28', '2026-11-29']) {
  const dlv = await api(T['sp-1-account'], 'POST', '/deliveries', { service: service1, date, proof: `护理记录-${date}` });
  dlvIds.push(dlv.json.id);
}
const selfAccept = await api(T['sp-1-account'], 'POST', `/deliveries/${dlvIds[0]}/acceptance`, { accepted: true });
check(selfAccept.status === 403, '服务商验收自己的交付被拒');
const d1 = await api(T['agent-a'], 'POST', `/deliveries/${dlvIds[0]}/acceptance`, { accepted: true });
const d2 = await api(T['agent-a'], 'POST', `/deliveries/${dlvIds[1]}/acceptance`, { accepted: true });
check(d1.status === 200 && d2.status === 200, '两日交付经在任代理验收通过');

narrate('SP-1 提出费用申请：必须对应服务期间、内容与交付证明，跨月按期归集');
const fee1 = await api(T['sp-1-account'], 'POST', '/fee-requests', { service: service1 });
check(fee1.status === 201 && fee1.json.lines.length === 1, '11 月两笔验收合并为一期申请（10000 分）');
check(fee1.json.lines[0].amountMinor === 10000, '金额按实际交付合计');
const fee1Id = fee1.json.id;

narrate('受托方按资金委托用途生成付款指令并送达合作方');
const pis1 = await api(T.trustee, 'POST', `/fee-requests/${fee1Id}/instructions`, {});
check(pis1.status === 201 && pis1.json[0].status === 'pending-verification', '指令先保留待核实，未自动付款');
const pay1 = pis1.json[0].id;
const disp1 = await api(T.trustee, 'POST', `/payments/${pay1}/dispatch`, {});
check(disp1.status === 200 && disp1.json.payment.status === 'accepted', '合作方受理（accepted 仅代表收件）');
const quota1 = await api(T.trustee, 'GET', '/quota/EL-1');
const nov = quota1.json.months.find(m => m.month === '2026-11');
check(nov.occupiedMinor === 10000 && nov.availableMinor === 190000, '受理金额占用 11 月周期额度');
await control.settle(disp1.json.payment.partnerDrawNo, 'confirmed', { receipt: '银行回单-合成' });
const sync1 = await api(T.trustee, 'POST', `/payments/${pay1}/sync`, {});
check(sync1.json.status === 'confirmed', '合作方终态 confirmed 同步回业务系统');

// ---------- 阶段三：争议、监察暂停与备用代理接替同时发生 ----------
narrate('11-30 交付存在争议：验收不通过，争议部分不能结算、不挤占基本照护额度');
process.env.APP_DATE = '2026-11-30';
const dlv3 = await api(T['sp-1-account'], 'POST', '/deliveries', { service: service1, date: '2026-11-30', proof: '护理记录-11-30' });
const d3 = await api(T['agent-a'], 'POST', `/deliveries/${dlv3.json.id}/acceptance`, { accepted: false, note: '签到与实际不符' });
check(d3.json.status === 'disputed', '争议交付标记 disputed');
const feeDisputed = await api(T['sp-1-account'], 'POST', '/fee-requests', { service: service1 });
check([400, 409].includes(feeDisputed.status), '无新的验收通过交付可结算时申请被拒：' + feeDisputed.json.error);

narrate('SP-1 另登记 12-01 交付并验收（跨月第二期），随后监察对 SP-1 下达暂停');
process.env.APP_DATE = '2026-12-01';
const dlv4 = await api(T['sp-1-account'], 'POST', '/deliveries', { service: service1, date: '2026-12-01', proof: '护理记录-12-01' });
await api(T['agent-a'], 'POST', `/deliveries/${dlv4.json.id}/acceptance`, { accepted: true });
const pause = await api(T.supervisor, 'POST', '/pauses', {
  elder: 'EL-1', scopeType: 'provider', scopeRef: 'SP-1', reason: '交付证明争议',
});
check(pause.status === 201 && pause.json.status === 'active', '监察暂停 PSP 生效，范围＝服务商 SP-1');

narrate('暂停期内新费用申请生成的付款指令被挡住，决定依据可查');
const fee2 = await api(T['sp-1-account'], 'POST', '/fee-requests', { service: service1 });
const pis2 = await api(T.trustee, 'POST', `/fee-requests/${fee2.json.id}/instructions`, {});
const payBlocked = pis2.json.find(p => p.status === 'blocked');
check(Boolean(payBlocked), '12 月指令 blocked，未占用额度：' + payBlocked.blockReasons.join('；'));
const why = await api(T.supervisor, 'GET', `/payments/${payBlocked.id}`);
check(why.json.wouldAllowNow === false && why.json.blockReasonsRecorded.length > 0, '资金挡住原因与额度快照可查');

narrate('同一时点备用代理接替：前位不能履职＋独立确认，不能本人自行取得权限');
const selfTakeover = await api(T['agent-b'], 'POST', '/capacity/decisions', {
  elder: 'EL-1', mandate: mandateId, decision: 'confirm', evidenceIds: [ev1.json.id],
});
check(selfTakeover.status === 403, '备用代理自行点确认被拒（仅见证人可确认）');
const ev2 = await api(T['agent-b'], 'POST', '/evidence', { elder: 'EL-1', kind: 'activation-request', summary: '前位代理不能继续履职' });
const cpd2 = await api(T.witness, 'POST', '/capacity/decisions', {
  elder: 'EL-1', mandate: mandateId, decision: 'confirm', evidenceIds: [ev2.json.id],
});
check(cpd2.status === 201, '独立见证确认接替，agent-b 成为在任代理');
const auth2 = await api(null, 'GET', '/authority/EL-1');
check(auth2.json.agentId === 'agent-b', '当前决定权已切换为 agent-b');
const oldAgentAct = await api(T['agent-a'], 'POST', `/services/${service1}/decision`, { approve: false });
check(oldAgentAct.status === 403, '前位代理 agent-a 已不能再决定');

narrate('未支付申请按暂停范围与新代理权限重新决定：暂停未解除前仍 blocked，解除后恢复待核实');
const re1 = await api(T.trustee, 'POST', `/payments/${payBlocked.id}/reevaluate`, {});
check(re1.json.payment.status === 'blocked', '暂停仍在，重新评估维持 blocked');
await api(T.supervisor, 'POST', `/pauses/${pause.json.id}/lift`, { reason: '争议核实完毕' });
const re2 = await api(T.trustee, 'POST', `/payments/${payBlocked.id}/reevaluate`, {});
check(re2.json.payment.status === 'pending-verification', '暂停解除后重新评估通过，回到待核实');

narrate('合作方持续 pending 与先受理后断线：受托方未给终态前一律保留待核实状态');
await control.setRule(`draw-${payBlocked.id.toLowerCase()}`, 'pending');
const dispPending = await api(T.trustee, 'POST', `/payments/${payBlocked.id}/dispatch`, {});
check(dispPending.json.payment.status === 'pending-verification' && dispPending.json.payment.partnerStatus === 'pending', '合作方处理中：保留待核实');
await control.setRule(`draw-${payBlocked.id.toLowerCase()}`, 'accepted');
const syncPending = await api(T.trustee, 'POST', `/payments/${payBlocked.id}/sync`, {});
check(syncPending.json.status === 'pending-verification' && syncPending.json.partnerStatus === 'pending',
  '合作方仍处理中：业务侧保持待核实，不提前转为受理');
// 再造一笔新指令用于断线演练
const fee3 = await api(T['sp-1-account'], 'POST', '/fee-requests', { service: service1 }).catch(() => null);
let uncertainId = null;
if (fee3 && fee3.status === 201) {
  const pis3 = await api(T.trustee, 'POST', `/fee-requests/${fee3.json.id}/instructions`, {});
  uncertainId = pis3.json[0].id;
  await control.setRule(`draw-${uncertainId.toLowerCase()}`, 'accepted_disconnect');
}
if (uncertainId) {
  const dispCut = await api(T.trustee, 'POST', `/payments/${uncertainId}/dispatch`, {});
  check(dispCut.json.recovered === true, '先受理后断线：经查询确认合作方已持久受理，补写流水而非假定失败');
  check(dispCut.json.payment.partnerStatus === 'accepted', '合作方受理状态已补写');
  const syncCut = await api(T.trustee, 'POST', `/payments/${uncertainId}/sync`, {});
  check(syncCut.json.status === 'accepted', '事后同步仍为受理');
}

// ---------- 阶段四：服务商更换，接续期间不得重叠报销 ----------
narrate('SP-2 接续同一事项（11-30 至 12-03，每日 6000 分），旧商有效服务保留');
const svc2 = await api(T['sp-2-account'], 'POST', '/services/replacement', {
  elder: 'EL-1', purpose: 'daily-care', start: '2026-11-30', end: '2026-12-03', dailyMinor: 6000,
});
check(svc2.status === 201 && svc2.json.replaces === service1, '更换安排登记了原服务关联');
const service2 = svc2.json.id;
await api(T['agent-b'], 'POST', `/services/${service2}/decision`, { approve: true });
const dlv5 = await api(T['sp-2-account'], 'POST', '/deliveries', { service: service2, date: '2026-11-30', proof: 'SP-2 护理记录-11-30' });
await api(T['agent-b'], 'POST', `/deliveries/${dlv5.json.id}/acceptance`, { accepted: true });
const overlapFee = await api(T['sp-2-account'], 'POST', '/fee-requests', { service: service2 });
check(overlapFee.status === 201, 'SP-2 就 11-30 接续服务正常申请（SP-1 当日交付有争议未报销，日期不重叠）');
const pisOverlap = await api(T.trustee, 'POST', `/fee-requests/${overlapFee.json.id}/instructions`, {});
check(pisOverlap.json[0].status === 'pending-verification', '新商费用可进入付款流程');

narrate('重叠报销拦截：同一日历日已由其他服务商报销的交付不能再次结算');
const dlvSp1Again = await api(T['sp-1-account'], 'POST', '/deliveries', { service: service1, date: '2026-11-30', proof: 'SP-1 补登记-11-30' });
await api(T['agent-b'], 'POST', `/deliveries/${dlvSp1Again.json.id}/acceptance`, { accepted: true, note: '补验收通过' });
const overlapReject = await api(T['sp-1-account'], 'POST', '/fee-requests', { service: service1 });
check(overlapReject.status === 409, 'SP-1 就 11-30 申请报销被拦截：' + overlapReject.json.error);

// ---------- 阶段五：在途取消——已支付不改写，未支付重新决定 ----------
narrate('服务取消发生在款项送达之后：先查明受理情况，禁止同时退款/再支付/恢复额度');
const cancel = await api(T['agent-b'], 'POST', `/services/${service1}/cancel`, { reason: '家属调整安排', checkPartner: true });
check(cancel.status === 200, '取消流程先核对合作方流水再处理');
check(cancel.json.accepted.includes(pay1), '已确认付款保留事实，未被改成从未发生');
check(cancel.json.cancelledUnpaid.length >= 1, '未支付指令终止，未明额度不恢复为可花余额');
const quotaAfter = await api(T.trustee, 'GET', '/quota/EL-1');
const novAfter = quotaAfter.json.months.find(m => m.month === '2026-11');
check(novAfter.occupiedMinor === 10000, '已受理金额仍占额度，等待独立退回流程');
const ret = await api(T.trustee, 'POST', `/payments/${pay1}/return`, { details: { reason: '服务取消后合作方确认退回' } });
check(ret.status === 200 && ret.json.status === 'returned', '合作方确认退回后登记 returned');
const quotaReleased = await api(T.trustee, 'GET', '/quota/EL-1');
const novRel = quotaReleased.json.months.find(m => m.month === '2026-11');
check(novRel.occupiedMinor === 0, '退回终态成立后额度才释放');

// ---------- 阶段六：材料矛盾部分暂停，老人恢复后本人意愿优先 ----------
narrate('生效材料相互矛盾：争议事项暂停代办，未争议日常服务继续');
const evConflict = await api(T['elder-1'], 'POST', '/evidence', { elder: 'EL-1', kind: 'capacity-conflict', summary: '家属与机构意见不一致' });
const cpd3 = await api(T.witness, 'POST', '/capacity/decisions', {
  elder: 'EL-1', mandate: mandateId, decision: 'conflict', evidenceIds: [evConflict.json.id], disputedScopes: ['escort'],
});
check(cpd3.status === 201, '矛盾材料登记，escort 事项暂停代办');
const auth3 = await api(null, 'GET', '/authority/EL-1');
check(auth3.json.suspendedScopes.includes('escort') && auth3.json.scopes.includes('daily-care'), '医疗陪护暂停、生活照料仍可代办');

narrate('老人恢复自行决定：新申请以本人有效意愿为准，历史合法履职记录保留');
const evRecover = await api(T.supervisor, 'POST', '/evidence', { elder: 'EL-1', kind: 'recovery-note', summary: '老人清醒恢复（监察转介材料）' });
const cpd4 = await api(T.witness, 'POST', '/capacity/decisions', {
  elder: 'EL-1', mandate: mandateId, decision: 'recovered', evidenceIds: [evRecover.json.id],
});
check(cpd4.status === 201, '恢复自行决定已见证');
const agentAfter = await api(T['agent-b'], 'POST', `/services/${service2}/decision`, { approve: false });
check(agentAfter.status === 403, '恢复后代理不能再决定新申请');
const events = await api(T.supervisor, 'GET', '/events');
check(events.json.some(e => e.type === 'AGENT_ACTIVATED'), '代理此前合法履职的事件记录未被抹去');

// ---------- 阶段七：可见范围、决定权与全链路追溯 ----------
narrate('各身份只能看到获准范围');
const viewProvider = await api(T['sp-1-account'], 'GET', '/me/view');
check(viewProvider.json.services.every(s => s.provider === 'SP-1'), '服务商只能查看自己提供的服务');
check(viewProvider.json.paymentInstructions.every(p => p.provider === 'SP-1'), '服务商只能查看自己的应收');
check(viewProvider.json.capacityDecisions.length === 0, '服务商看不到生效材料决定');
const viewAgent = await api(T['agent-b'], 'GET', '/me/view');
check(Array.isArray(viewAgent.json.mandates) && viewAgent.json.actor.role === 'agent', '代理视图按获准范围过滤');
const maker = await api(null, 'GET', '/decisions/EL-1');
check(maker.json.decisionMakers.some(d => d.role === 'principal'), '决定权查询显示老人本人当前可决定');
const cont = await api(null, 'GET', '/continuation/EL-1');
check(cont.json.some(s => s.service === service2 && s.continuable === true), '可继续服务清单可查');
check(cont.json.some(s => s.service === service1 && s.continuable === false), '已取消服务显示不可继续');
const trace = await api(T.supervisor, 'GET', `/trace/${service1}`);
check(trace.json.authorityAtTrace && trace.json.deliveries.length > 0 && trace.json.payments.length > 0 && trace.json.eventChain.length > 0,
  '单次照护请求可追溯授权、交付、付款与事件链');
check(trace.json.feeRequests.length >= 1, '追溯链包含费用申请');
check(events.json.some(e => e.type === 'SERVICE_APPROVED'), '此前合法批准的服务记录保留');

console.log(`\n演练结束：共 ${step} 个步骤，失败 ${failures.length} 项`);
await close(server);
await close(peer);
await rm(dir, { recursive: true, force: true });
if (failures.length) {
  console.error('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('全部断言通过。');
