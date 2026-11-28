// 费用申请与定向付款：验收要求、用途/额度/收款方/暂停约束、跨月拆分、重叠报销、额度占用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { registerMandate, submitEvidence, decideCapacity } from '../src/authority.mjs';
import { submitService, decideService, addDelivery, acceptDelivery } from '../src/services.mjs';
import { createFeeRequest, issuePaymentInstructions, evaluateLine, reevaluateInstruction, quotaView } from '../src/payments.mjs';
import { createPause, liftPause } from '../src/supervision.mjs';
import { splitByMonth } from '../src/dates.mjs';

process.env.APP_DATE = '2026-11-28';
const seedFile = new URL('../fixtures/records.json', import.meta.url);

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'pay-'));
  const store = new Store(join(dir, 'state.json'), JSON.parse(await readFile(seedFile, 'utf8')));
  const A = id => store.state.actors.find(a => a.id === id);
  const mandate = registerMandate(store, A('elder-1'), {
    elder: 'EL-1', scopes: ['daily-care', 'escort'], primary: 'agent-a', backup: 'agent-b',
    validFrom: '2026-11-01', until: '2027-01-31',
  });
  const ev = submitEvidence(store, A('agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, A('witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev.id] });
  return { store, dir, A, mandate };
}
async function approvedService(store, A, { start = '2026-11-28', end = '2026-11-29', dailyMinor = 5000, purpose = 'daily-care', provider = 'sp-1-account', providerId = 'SP-1' } = {}) {
  const svc = submitService(store, A(provider), { elder: 'EL-1', purpose, start, end, dailyMinor });
  decideService(store, A('agent-a'), svc.id, true);
  return svc;
}
async function deliverAndAccept(store, A, svc, dates) {
  const ids = [];
  for (const date of dates) {
    const d = addDelivery(store, store.state.actors.find(a => a.providerId === svc.provider), { service: svc.id, date });
    acceptDelivery(store, A('agent-a'), d.id, true);
    ids.push(d.id);
  }
  return ids;
}

test('跨月服务按实际每日归属拆分金额', () => {
  const lines = splitByMonth('2026-11-28', '2026-12-03', 5000);
  assert.deepEqual(lines.map(l => l.month), ['2026-11', '2026-12']);
  assert.equal(lines[0].days, 3);
  assert.equal(lines[1].days, 3);
  assert.equal(lines.reduce((s, l) => s + l.amountMinor, 0), 30000);
});

test('只有验收通过部分可结算，服务商不能自行验收', async () => {
  const { store, dir, A } = await harness();
  const svc = await approvedService(store, A, {});
  const d = addDelivery(store, A('sp-1-account'), { service: svc.id, date: '2026-11-28' });
  assert.throws(() => acceptDelivery(store, A('sp-1-account'), d.id, true), e => e.code === 'FORBIDDEN');
  acceptDelivery(store, A('agent-a'), d.id, false, '证明不足');
  assert.throws(() => createFeeRequest(store, A('sp-1-account'), { service: svc.id }), e => e.code === 'VALIDATION');
  await rm(dir, { recursive: true, force: true });
});

test('付款受资金用途约束：escort 不在用途内被挡住且不占额度', async () => {
  const { store, dir, A } = await harness();
  const svc = await approvedService(store, A, { start: '2026-11-28', end: '2026-11-28', dailyMinor: 8000, purpose: 'escort', provider: 'sp-2-account', providerId: 'SP-2' });
  await deliverAndAccept(store, A, svc, ['2026-11-28']);
  const fee = createFeeRequest(store, A('sp-2-account'), { service: svc.id });
  const pis = issuePaymentInstructions(store, A('trustee'), fee.id);
  assert.equal(pis[0].status, 'blocked');
  assert.ok(pis[0].blockReasons.some(r => r.includes('用途不含')));
  const quota = quotaView(store, 'EL-1');
  assert.equal(quota.months.find(m => m.month === '2026-11').occupiedMinor, 0);
  await rm(dir, { recursive: true, force: true });
});

test('禁止利益冲突收款方：代理作为收款方被挡住', async () => {
  const { store, dir, A } = await harness();
  store.state.providers.push({ id: 'SP-X', services: ['daily-care'] });
  store.state.actors.push({ id: 'sp-x-account', role: 'provider', providerId: 'SP-X' });
  const trust = store.state.trusts.find(t => t.elder === 'EL-1');
  trust.forbiddenPayees.push('SP-X');
  const svc = submitService(store, A('sp-x-account'), { elder: 'EL-1', purpose: 'daily-care', start: '2026-11-28', end: '2026-11-28', dailyMinor: 100 });
  decideService(store, A('agent-a'), svc.id, true);
  await deliverAndAccept(store, A, svc, ['2026-11-28']);
  const fee = createFeeRequest(store, A('sp-x-account'), { service: svc.id });
  const pis = issuePaymentInstructions(store, A('trustee'), fee.id);
  assert.equal(pis[0].status, 'blocked');
  assert.ok(pis[0].blockReasons.some(r => r.includes('利益冲突')));
  await rm(dir, { recursive: true, force: true });
});

test('周期额度：超限被挡住，已受理指令占用额度', async () => {
  const { store, dir, A } = await harness();
  const trust = store.state.trusts.find(t => t.elder === 'EL-1');
  trust.monthlyLimitMinor = 12000;
  const svc = await approvedService(store, A, { start: '2026-11-28', end: '2026-11-30', dailyMinor: 5000 });
  await deliverAndAccept(store, A, svc, ['2026-11-28', '2026-11-29', '2026-11-30']);
  const fee = createFeeRequest(store, A('sp-1-account'), { service: svc.id });
  assert.equal(fee.lines[0].amountMinor, 15000);
  const eval0 = evaluateLine(store, { elderId: 'EL-1', providerId: 'SP-1', scope: 'daily-care', month: '2026-11', amountMinor: 15000, serviceId: svc.id });
  assert.equal(eval0.allowed, false);
  assert.ok(eval0.reasons.some(r => r.includes('周期额度')));
  const pis = issuePaymentInstructions(store, A('trustee'), fee.id);
  assert.equal(pis[0].status, 'blocked');
  // 争议部分不得挤占基本照护额度：挡住时额度完全可用
  assert.equal(quotaView(store, 'EL-1').months[0].availableMinor, 12000);
  await rm(dir, { recursive: true, force: true });
});

test('监察暂停挡住未支付申请，解除后重新评估恢复，已支付不改写', async () => {
  const { store, dir, A } = await harness();
  const svc = await approvedService(store, A, { start: '2026-11-28', end: '2026-11-30', dailyMinor: 5000 });
  await deliverAndAccept(store, A, svc, ['2026-11-28', '2026-11-29']);
  const fee = createFeeRequest(store, A('sp-1-account'), { service: svc.id });
  const [pi] = issuePaymentInstructions(store, A('trustee'), fee.id);
  assert.equal(pi.status, 'pending-verification');
  // 模拟已受理
  pi.status = 'accepted';
  const pause = createPause(store, A('supervisor'), { elder: 'EL-1', scopeType: 'provider', scopeRef: 'SP-1', reason: '争议' });
  const reAccepted = reevaluateInstruction(store, A('trustee'), pi.id);
  assert.equal(reAccepted.changed, false);
  assert.equal(reAccepted.payment.status, 'accepted', '已受理不能改成从未发生');
  // 新的未支付指令被暂停挡住
  const d3 = addDelivery(store, A('sp-1-account'), { service: svc.id, date: '2026-11-30' });
  acceptDelivery(store, A('agent-a'), d3.id, true);
  const fee2 = createFeeRequest(store, A('sp-1-account'), { service: svc.id });
  const [pi2] = issuePaymentInstructions(store, A('trustee'), fee2.id);
  assert.equal(pi2.status, 'blocked');
  liftPause(store, A('supervisor'), pause.id, '核实完毕');
  const re2 = reevaluateInstruction(store, A('trustee'), pi2.id);
  assert.equal(re2.payment.status, 'pending-verification');
  await rm(dir, { recursive: true, force: true });
});

test('服务商更换：接续期间同一日历日不能重叠报销', async () => {
  const { store, dir, A } = await harness();
  const svc1 = await approvedService(store, A, { start: '2026-11-28', end: '2026-11-30', dailyMinor: 5000 });
  await deliverAndAccept(store, A, svc1, ['2026-11-28', '2026-11-29']);
  const fee1 = createFeeRequest(store, A('sp-1-account'), { service: svc1.id });
  issuePaymentInstructions(store, A('trustee'), fee1.id);
  // SP-2 接续并覆盖 11-29
  const svc2 = submitService(store, A('sp-2-account'), { elder: 'EL-1', purpose: 'daily-care', start: '2026-11-29', end: '2026-11-30', dailyMinor: 6000 });
  decideService(store, A('agent-a'), svc2.id, true);
  const d = addDelivery(store, A('sp-2-account'), { service: svc2.id, date: '2026-11-29' });
  acceptDelivery(store, A('agent-a'), d.id, true);
  assert.throws(() => createFeeRequest(store, A('sp-2-account'), { service: svc2.id }), e => e.code === 'CONFLICT' && e.message.includes('重叠'));
  await rm(dir, { recursive: true, force: true });
});

test('受托方之外的角色不能受理付款', async () => {
  const { store, dir, A } = await harness();
  const svc = await approvedService(store, A, {});
  await deliverAndAccept(store, A, svc, ['2026-11-28']);
  const fee = createFeeRequest(store, A('sp-1-account'), { service: svc.id });
  assert.throws(() => issuePaymentInstructions(store, A('supervisor'), fee.id), e => e.code === 'FORBIDDEN');
  await rm(dir, { recursive: true, force: true });
});
