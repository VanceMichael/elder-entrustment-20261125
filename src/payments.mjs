// 费用申请、付款指令与资金委托约束。
// 安排照护不等于允许付款；付款另受用途、周期额度、收款方、利益冲突、暂停与验收约束。
import { DomainError, today, monthKey } from './dates.mjs';
import { activePauses, pauseMatches } from './supervision.mjs';

// 服务商提出费用申请：必须对应服务期间、服务内容和实际交付证明，只有验收通过部分可结算。
export function createFeeRequest(store, actor, body) {
  if (actor.role !== 'provider' || !actor.providerId) throw new DomainError('FORBIDDEN', '只有服务机构可提出费用申请');
  const service = store.get('services', body.service);
  if (actor.providerId !== service.provider) throw new DomainError('FORBIDDEN', '只能就自己提供的服务申请费用');
  if (['rejected', 'cancelled'].includes(service.status)) throw new DomainError('CONFLICT', `服务状态 ${service.status}，不能申请费用`);

  const accepted = store.state.deliveries.filter(d =>
    d.service === service.id && d.accepted && d.status === 'accepted');
  if (!accepted.length) throw new DomainError('VALIDATION', '没有已验收通过的交付，不能结算');

  const alreadyBilled = new Set();
  for (const fr of store.state.feeRequests.filter(f => f.service === service.id && f.status !== 'rejected')) {
    for (const line of fr.lines) for (const did of line.deliveryIds) alreadyBilled.add(did);
  }
  const fresh = accepted.filter(d => !alreadyBilled.has(d.id));

  // 服务商更换：旧商未结清的有效服务与新商接续期间不能重叠报销（优先于"无新交付"判定）。
  for (const delivery of fresh.length ? fresh : accepted) {
    const other = store.state.feeRequests.find(fr =>
      fr.status !== 'rejected' && fr.provider !== service.provider &&
      fr.lines.some(l => l.dates.includes(delivery.date)));
    if (other) throw new DomainError('CONFLICT', `${delivery.date} 已有其他服务商 ${other.provider} 的报销，接续期间不能重叠`);
  }

  if (!fresh.length) throw new DomainError('CONFLICT', '验收交付均已申请，不能重复结算');

  // 跨月服务按各期实际占用拆分；争议部分不得进入申请。
  const byMonth = new Map();
  for (const delivery of fresh) {
    const month = monthKey(delivery.date);
    if (!byMonth.has(month)) byMonth.set(month, { month, amountMinor: 0, deliveryIds: [], dates: [] });
    const line = byMonth.get(month);
    line.amountMinor += delivery.amountMinor;
    line.deliveryIds.push(delivery.id);
    line.dates.push(delivery.date);
  }
  const lines = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  const request = {
    id: store.nextId('FEE'),
    elder: service.elder,
    service: service.id,
    provider: service.provider,
    purpose: service.purpose,
    lines,
    status: 'submitted',
    submittedBy: actor.id,
    createdAt: today(),
  };
  store.add('feeRequests', request);
  store.record('FEE_REQUESTED', actor.id, { lines: lines.map(l => ({ month: l.month, amountMinor: l.amountMinor })) }, { feeRequest: request.id, service: service.id, elder: service.elder });
  return request;
}

// 周期额度占用：已受理及之后状态、且未退回的指令占用额度；blocked/pending-verification 不占额度。
function quotaOccupied(store, trust, month) {
  return store.state.paymentInstructions
    .filter(pi => pi.trust === trust.id && pi.month === month &&
      ['accepted', 'confirmed', 'paid'].includes(pi.status))
    .reduce((sum, pi) => sum + pi.amountMinor, 0);
}

// 评估一条月度费用行能否形成付款指令，返回 { allowed, reasons[] }。
export function evaluateLine(store, { elderId, providerId, scope, month, amountMinor, serviceId }) {
  const reasons = [];
  const trust = store.state.trusts.find(t => t.elder === elderId);
  if (!trust) { reasons.push('未登记资金委托'); return { allowed: false, reasons }; }
  if (!trust.purposes.includes(scope)) reasons.push(`资金委托用途不含 ${scope}`);
  if (trust.forbiddenPayees.includes(providerId)) reasons.push('收款方在禁止利益冲突名单内');
  const pause = activePauses(store, elderId).find(p => pauseMatches(p, { service: serviceId, provider: providerId, scope, elderId }));
  if (pause) reasons.push(`监察暂停 ${pause.id}（${pause.scopeType}:${pause.scopeRef}）覆盖该支出`);
  const occupied = quotaOccupied(store, trust, month);
  if (occupied + amountMinor > trust.monthlyLimitMinor) {
    reasons.push(`超出 ${month} 周期额度：已占 ${occupied} + 本笔 ${amountMinor} > 额度 ${trust.monthlyLimitMinor}（分）`);
  }
  return { allowed: reasons.length === 0, reasons, occupied, limit: trust.monthlyLimitMinor };
}

// 受托方按已获准用途受理：逐期生成付款指令；未获准的保留 blocked 决定依据，不占用额度。
export function issuePaymentInstructions(store, actor, feeRequestId) {
  if (actor.role !== 'trustee') throw new DomainError('FORBIDDEN', '只有资金受托方可受理付款');
  const fr = store.get('feeRequests', feeRequestId);
  if (fr.status !== 'submitted') throw new DomainError('CONFLICT', '费用申请不在待受理状态');
  const results = [];
  for (const line of fr.lines) {
    const existing = store.state.paymentInstructions.find(pi => pi.feeRequest === fr.id && pi.month === line.month);
    if (existing) { results.push(existing); continue; }
    const evaluation = evaluateLine(store, {
      elderId: fr.elder, providerId: fr.provider, scope: fr.purpose,
      month: line.month, amountMinor: line.amountMinor, serviceId: fr.service,
    });
    const pi = {
      id: store.nextId('PAY'),
      feeRequest: fr.id,
      elder: fr.elder,
      service: fr.service,
      provider: fr.provider,
      purpose: fr.purpose,
      month: line.month,
      amountMinor: line.amountMinor,
      deliveryIds: [...line.deliveryIds],
      trust: store.state.trusts.find(t => t.elder === fr.elder)?.id ?? null,
      status: evaluation.allowed ? 'pending-verification' : 'blocked',
      blockReasons: evaluation.reasons,
      partnerDrawNo: null,
      partnerStatus: null,
      history: [{ status: evaluation.allowed ? 'pending-verification' : 'blocked', at: today(), by: actor.id, reasons: evaluation.reasons }],
    };
    store.add('paymentInstructions', pi);
    store.record(evaluation.allowed ? 'PAYMENT_PENDING' : 'PAYMENT_BLOCKED', actor.id, { reasons: evaluation.reasons }, { payment: pi.id, feeRequest: fr.id, elder: fr.elder });
    results.push(pi);
  }
  fr.status = results.some(pi => pi.status === 'blocked') ? 'partially-blocked' : 'instructed';
  return results;
}

// 暂停相遇/代理接替后重新决定未支付申请；已支付的事实不改写。
export function reevaluateInstruction(store, actor, paymentId) {
  if (!['trustee', 'supervisor'].includes(actor.role)) throw new DomainError('FORBIDDEN', '只有受托方或监察方可发起重新评估');
  const pi = store.get('paymentInstructions', paymentId);
  if (['accepted', 'confirmed', 'paid', 'returned'].includes(pi.status)) {
    return { payment: pi, changed: false, note: '已受理/已支付的服务不能改成从未发生，保持原状态' };
  }
  const evaluation = evaluateLine(store, {
    elderId: pi.elder, providerId: pi.provider, scope: pi.purpose,
    month: pi.month, amountMinor: pi.amountMinor, serviceId: pi.service,
  });
  const next = evaluation.allowed ? 'pending-verification' : 'blocked';
  const changed = pi.status !== next || JSON.stringify(pi.blockReasons) !== JSON.stringify(evaluation.reasons);
  pi.status = next;
  pi.blockReasons = evaluation.reasons;
  pi.history.push({ status: next, at: today(), by: actor.id, reasons: evaluation.reasons });
  store.record('PAYMENT_REEVALUATED', actor.id, { status: next, reasons: evaluation.reasons }, { payment: pi.id, elder: pi.elder });
  return { payment: pi, changed, evaluation };
}

// 同步合作方（受托付款机构）状态：受理仅代表合作方收件，终态以 confirmed/returned 为准。
const PARTNER_MAP = {
  accepted: 'accepted',
  pending: 'pending-verification',
  rejected: 'rejected',
  confirmed: 'confirmed',
  returned: 'returned',
};

export async function syncFromPartner(store, actor, paymentId, partnerClient) {
  if (actor.role !== 'trustee') throw new DomainError('FORBIDDEN', '只有资金受托方可核对合作方状态');
  const pi = store.get('paymentInstructions', paymentId);
  if (!pi.partnerDrawNo) throw new DomainError('CONFLICT', '指令尚未送达合作方');
  const draw = await partnerClient.lookup(pi.partnerDrawNo);
  const mapped = PARTNER_MAP[draw.status] ?? pi.status;
  if (mapped !== pi.partnerStatus || pi.status !== mapped) {
    pi.partnerStatus = draw.status;
    if (['accepted', 'confirmed', 'returned', 'rejected'].includes(mapped)) pi.status = mapped;
    pi.history.push({ status: pi.status, at: today(), by: actor.id, partnerRevision: draw.revision });
    store.record('PAYMENT_SYNCED', actor.id, { partnerStatus: draw.status, revision: draw.revision }, { payment: pi.id });
  }
  return pi;
}

// 服务取消发生在款项送达受托方之后：先查明是否已受理，禁止同时退款/再支付/恢复额度。
export async function cancelServiceFlow(store, actor, serviceId, reason, partnerClient) {
  const service = store.get('services', serviceId);
  const payments = store.state.paymentInstructions.filter(pi => pi.service === service.id);
  const findings = [];
  for (const pi of payments) {
    if (pi.partnerDrawNo && ['accepted', 'confirmed', 'pending-verification'].includes(pi.status)) {
      const draw = await partnerClient.lookup(pi.partnerDrawNo);
      pi.partnerStatus = draw.status;
      findings.push({ payment: pi.id, partnerStatus: draw.status });
    }
  }
  const accepted = payments.filter(pi => ['accepted', 'confirmed', 'paid'].includes(pi.status));
  const inFlight = payments.filter(pi => ['pending-verification'].includes(pi.status));
  const blocked = payments.filter(pi => pi.status === 'blocked');

  // 已受理：保留付款事实，不能作未发生，需走独立退回流程；未受理/受阻：终止指令并释放未明占用。
  for (const pi of inFlight) {
    pi.status = 'cancelled-unpaid';
    pi.history.push({ status: pi.status, at: today(), by: actor.id, reason });
    store.record('PAYMENT_CANCELLED_UNPAID', actor.id, {}, { payment: pi.id });
  }
  for (const pi of blocked) {
    pi.status = 'cancelled-unpaid';
    pi.history.push({ status: pi.status, at: today(), by: actor.id, reason });
  }
  if (accepted.length) {
    store.record('CANCEL_HELD_PAID', actor.id, { payments: accepted.map(p => p.id), note: '已受理款项不得自行退款或恢复额度，须等待合作方退回终态' }, { service: serviceId });
  }
  const { cancelService } = await import('./services.mjs');
  cancelService(store, actor, serviceId, reason);
  return { service, accepted: accepted.map(p => p.id), cancelledUnpaid: [...inFlight, ...blocked].map(p => p.id), partnerFindings: findings };
}

// 合作方确认退回后登记，退回金额释放周期额度（状态不再计入占用）。
export function registerReturn(store, actor, paymentId, details) {
  if (actor.role !== 'trustee') throw new DomainError('FORBIDDEN', '只有资金受托方可登记退回');
  const pi = store.get('paymentInstructions', paymentId);
  if (pi.status !== 'accepted' && pi.partnerStatus !== 'confirmed') throw new DomainError('CONFLICT', '仅已受理/确认的指令可登记退回');
  pi.status = 'returned';
  pi.returnDetails = details ?? {};
  pi.history.push({ status: 'returned', at: today(), by: actor.id });
  store.record('PAYMENT_RETURNED', actor.id, details ?? {}, { payment: pi.id });
  return pi;
}

export function quotaView(store, elderId) {
  const trust = store.state.trusts.find(t => t.elder === elderId);
  if (!trust) return null;
  const months = [...new Set(store.state.paymentInstructions.filter(pi => pi.trust === trust.id).map(pi => pi.month))].sort();
  return {
    trust: trust.id,
    purposes: trust.purposes,
    forbiddenPayees: trust.forbiddenPayees,
    monthlyLimitMinor: trust.monthlyLimitMinor,
    months: months.map(month => ({
      month,
      occupiedMinor: quotaOccupied(store, trust, month),
      availableMinor: trust.monthlyLimitMinor - quotaOccupied(store, trust, month),
    })),
  };
}
