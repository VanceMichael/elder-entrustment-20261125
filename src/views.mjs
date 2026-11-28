// 查询视图：决定权、服务可继续性、资金占用解释、单次照护请求全链路追溯，以及按角色的可见范围过滤。
import { effectiveAuthority } from './authority.mjs';
import { continuationStatus } from './services.mjs';
import { activePauses } from './supervision.mjs';
import { evaluateLine, quotaView } from './payments.mjs';

export function decisionMakers(store, elderId) {
  const auth = effectiveAuthority(store, elderId);
  const rows = [];
  if (auth.selfDetermining) {
    const principal = store.state.actors.find(a => a.role === 'principal' && a.elder === elderId);
    rows.push({ actorId: principal?.id ?? null, role: 'principal', scopes: ['daily-care', 'escort', 'designated-expense'], basis: auth.reasons.join('；') });
  }
  if (auth.agentId) {
    rows.push({ actorId: auth.agentId, role: 'agent', scopes: auth.scopes, suspendedScopes: auth.suspendedScopes, basis: auth.reasons.join('；') });
  }
  return { elderId, selfDetermining: auth.selfDetermining, mandate: auth.mandate, decisionMakers: rows };
}

export function servicesContinuation(store, elderId) {
  const pauses = activePauses(store, elderId);
  return store.state.services
    .filter(s => s.elder === elderId)
    .map(service => ({
      service: service.id,
      provider: service.provider,
      purpose: service.purpose,
      period: { start: service.start, end: service.end },
      status: service.status,
      ...continuationStatus(store, service, pauses),
    }));
}

export function explainPayment(store, paymentId) {
  const pi = store.get('paymentInstructions', paymentId);
  const evaluation = evaluateLine(store, {
    elderId: pi.elder, providerId: pi.provider, scope: pi.purpose,
    month: pi.month, amountMinor: pi.amountMinor, serviceId: pi.service,
  });
  return {
    payment: pi.id,
    status: pi.status,
    amountMinor: pi.amountMinor,
    month: pi.month,
    wouldAllowNow: evaluation.allowed,
    reasons: evaluation.reasons,
    quotaSnapshot: { occupiedMinor: evaluation.occupied, limitMinor: evaluation.limit },
    blockReasonsRecorded: pi.blockReasons,
    partner: pi.partnerDrawNo ? { drawNo: pi.partnerDrawNo, status: pi.partnerStatus } : null,
    history: pi.history,
  };
}

// 按一次照护请求追溯授权、交付与付款。
export function traceService(store, serviceId) {
  const service = store.get('services', serviceId);
  const authority = effectiveAuthority(store, service.elder);
  const deliveries = store.state.deliveries.filter(d => d.service === service.id);
  const fees = store.state.feeRequests.filter(f => f.service === service.id);
  const payments = store.state.paymentInstructions.filter(pi => pi.service === service.id);
  const pauses = store.state.pauses.filter(p => p.elder === service.elder);
  return {
    service,
    authorityAtTrace: authority,
    deliveries: deliveries.map(d => ({ id: d.id, date: d.date, amountMinor: d.amountMinor, status: d.status, accepted: d.accepted, proof: d.proof })),
    feeRequests: fees.map(f => ({ id: f.id, status: f.status, lines: f.lines })),
    payments: payments.map(pi => ({
      id: pi.id, status: pi.status, month: pi.month, amountMinor: pi.amountMinor,
      blockReasons: pi.blockReasons, partner: pi.partnerDrawNo ? { drawNo: pi.partnerDrawNo, status: pi.partnerStatus } : null,
    })),
    pauses: pauses.map(p => ({ id: p.id, scopeType: p.scopeType, scopeRef: p.scopeRef, status: p.status, reason: p.reason })),
    eventChain: store.state.events
      .filter(e => e.refs?.service === service.id || payments.some(pi => pi.id === e.refs?.payment) ||
        fees.some(f => f.id === e.refs?.feeRequest) || deliveries.some(d => d.id === e.refs?.delivery))
      .map(e => ({ seq: e.id, type: e.type, actorId: e.actorId, at: e.at, refs: e.refs })),
  };
}

// 角色可见范围：老人/代理只看获准范围；服务商只看自己；监察看依据但不能下单。
export function visibleState(store, actor) {
  const s = store.state;
  const filterElder = elderId => {
    if (actor.role === 'principal') return actor.elder === elderId;
    if (actor.role === 'agent') return effectiveAuthority(store, elderId).agentId === actor.id;
    if (actor.role === 'provider') return true; // 进一步按 provider 过滤
    return true; // witness / trustee / supervisor 可查全部业务对象
  };
  const scopeAllowed = elderId => {
    if (actor.role !== 'agent') return null;
    return effectiveAuthority(store, elderId).scopes;
  };

  const services = s.services.filter(svc => {
    if (!filterElder(svc.elder)) return false;
    if (actor.role === 'provider' && svc.provider !== actor.providerId) return false;
    const allowed = scopeAllowed(svc.elder);
    if (allowed && !allowed.includes(svc.purpose)) return false;
    return true;
  }).map(stripInternal);

  return {
    actor: { id: actor.id, role: actor.role, providerId: actor.providerId ?? null },
    mandates: s.mandates.filter(m => filterElder(m.elder)).map(stripInternal),
    capacityDecisions: actor.role === 'provider' ? [] : s.capacityDecisions.filter(d => filterElder(d.elder)).map(stripInternal),
    services,
    deliveries: s.deliveries.filter(d => {
      if (actor.role === 'provider' && d.provider !== actor.providerId) return false;
      return services.some(svc => svc.id === d.service);
    }).map(stripInternal),
    feeRequests: s.feeRequests.filter(f => {
      if (actor.role === 'provider' && f.provider !== actor.providerId) return false;
      if (!filterElder(f.elder)) return false;
      const allowed = scopeAllowed(f.elder);
      return !(allowed && !allowed.includes(f.purpose));
    }).map(stripInternal),
    paymentInstructions: s.paymentInstructions.filter(pi => {
      if (actor.role === 'provider') return pi.provider === actor.providerId;
      if (actor.role === 'witness') return false; // 见证人员确认文书，不查资金流水
      return filterElder(pi.elder);
    }).map(stripInternal),
    pauses: actor.role === 'provider'
      ? s.pauses.filter(p => p.scopeType === 'provider' && p.scopeRef === actor.providerId).map(stripInternal)
      : s.pauses.map(stripInternal),
    quota: actor.role === 'agent' || actor.role === 'principal' || actor.role === 'supervisor' || actor.role === 'trustee'
      ? s.elders.filter(e => filterElder(e.id)).map(e => quotaView(store, e.id)).filter(Boolean)
      : [],
  };
}

function stripInternal(row) {
  const { history, ...rest } = row;
  return rest;
}
