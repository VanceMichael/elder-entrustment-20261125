// 具体照护安排（服务商提交）、实际交付与验收、取消、服务商更换。
import { DomainError, today, assertDate, rangesOverlap, splitByMonth } from './dates.mjs';
import { canDecide } from './authority.mjs';

// 服务商提出具体照护安排；安排照护与允许给自己付款是两件事。
export function submitService(store, actor, body) {
  if (actor.role !== 'provider' || !actor.providerId) throw new DomainError('FORBIDDEN', '只有服务机构可提交照护安排');
  const provider = store.get('providers', actor.providerId);
  const elder = store.get('elders', body.elder);
  if (!provider.services.includes(body.purpose)) throw new DomainError('VALIDATION', '该服务商未登记此项服务内容');
  assertDate(body.start, 'start');
  assertDate(body.end, 'end');
  if (body.end < body.start) throw new DomainError('VALIDATION', '服务结束日不能早于开始日');
  if (!Number.isInteger(body.dailyMinor) || body.dailyMinor <= 0) throw new DomainError('VALIDATION', 'dailyMinor 必须是正整数（分）');
  const service = {
    id: store.nextId('SVC'),
    elder: elder.id,
    provider: provider.id,
    purpose: body.purpose,
    start: body.start,
    end: body.end,
    dailyMinor: body.dailyMinor,
    status: 'submitted',
    submittedBy: actor.id,
    history: [{ status: 'submitted', at: today(), by: actor.id }],
  };
  store.add('services', service);
  store.record('SERVICE_SUBMITTED', actor.id, { purpose: service.purpose, start: service.start, end: service.end }, { service: service.id, elder: elder.id, provider: provider.id });
  return service;
}

// 老人本人或在任代理批准安排（按当前决定权）。
export function decideService(store, actor, serviceId, approve, note = '') {
  const service = store.get('services', serviceId);
  // 先校验决定权，再校验安排状态，确保"无权决定"优先暴露。
  const check = canDecide(store, actor, service.elder, service.purpose);
  if (!check.allowed) throw new DomainError('FORBIDDEN', `无权批准：${check.reason}`);
  if (service.status !== 'submitted') throw new DomainError('CONFLICT', `安排当前状态 ${service.status}，不可再决定`);
  service.status = approve ? 'approved' : 'rejected';
  service.decidedBy = actor.id;
  service.decidedAt = today();
  service.history.push({ status: service.status, at: today(), by: actor.id, note });
  store.record(approve ? 'SERVICE_APPROVED' : 'SERVICE_REJECTED', actor.id, { note }, { service: serviceId, elder: service.elder });
  return service;
}

// 服务商登记实际交付；只有经过验收的部分可以结算。
export function addDelivery(store, actor, body) {
  const service = store.get('services', body.service);
  if (actor.role !== 'provider' || actor.providerId !== service.provider) throw new DomainError('FORBIDDEN', '只能登记自己服务的交付');
  if (!['approved', 'in-delivery'].includes(service.status)) throw new DomainError('CONFLICT', '安排未获批准，不能登记交付');
  assertDate(body.date, 'date');
  if (body.date < service.start || body.date > service.end) throw new DomainError('VALIDATION', '交付日期不在服务期间内');
  if (store.state.deliveries.some(d => d.service === service.id && d.date === body.date)) {
    throw new DomainError('CONFLICT', '该日交付已登记，不能重复');
  }
  const amount = body.amountMinor ?? service.dailyMinor;
  if (!Number.isInteger(amount) || amount <= 0) throw new DomainError('VALIDATION', 'amountMinor 必须是正整数（分）');
  const delivery = {
    id: store.nextId('DLV'),
    service: service.id,
    elder: service.elder,
    provider: service.provider,
    date: body.date,
    amountMinor: amount,
    proof: body.proof ?? '',
    status: 'delivered',
    accepted: false,
    disputeNote: null,
  };
  store.add('deliveries', delivery);
  service.status = 'in-delivery';
  service.history.push({ status: 'delivery', at: today(), by: actor.id, delivery: delivery.id });
  store.record('DELIVERY_REPORTED', actor.id, { date: body.date, amountMinor: amount }, { delivery: delivery.id, service: service.id });
  return delivery;
}

// 验收：由有权决定者确认实际交付（服务商不能验收自己的交付）。
export function acceptDelivery(store, actor, deliveryId, accepted, note = '') {
  const delivery = store.get('deliveries', deliveryId);
  if (actor.role === 'provider') throw new DomainError('FORBIDDEN', '服务商不能自行验收');
  const service = store.get('services', delivery.service);
  const check = canDecide(store, actor, delivery.elder, service.purpose, delivery.date);
  if (!check.allowed && actor.role !== 'supervisor') throw new DomainError('FORBIDDEN', `无权验收：${check.reason}`);
  delivery.accepted = Boolean(accepted);
  delivery.status = accepted ? 'accepted' : 'disputed';
  delivery.disputeNote = accepted ? null : (note || '验收未通过');
  delivery.acceptedBy = actor.id;
  delivery.acceptedAt = today();
  store.record(accepted ? 'DELIVERY_ACCEPTED' : 'DELIVERY_DISPUTED', actor.id, { note }, { delivery: deliveryId, service: delivery.service });
  return delivery;
}

// 取消安排：若款项已送达受托方，先查明付款是否已受理（见 payments.cancelServiceFlow）。
export function cancelService(store, actor, serviceId, reason) {
  const service = store.get('services', serviceId);
  if (actor.role === 'provider' && actor.providerId !== service.provider) throw new DomainError('FORBIDDEN', '只能取消自己的安排');
  if (!['provider', 'principal', 'agent', 'supervisor'].includes(actor.role)) throw new DomainError('FORBIDDEN', '该身份不能取消服务');
  if (['completed', 'cancelled'].includes(service.status)) throw new DomainError('CONFLICT', '服务已终态，不能取消');
  service.status = 'cancelled';
  service.cancelledBy = actor.id;
  service.cancelledAt = today();
  service.cancelReason = reason ?? '';
  service.history.push({ status: 'cancelled', at: today(), by: actor.id, reason });
  store.record('SERVICE_CANCELLED', actor.id, { reason }, { service: serviceId, elder: service.elder });
  return service;
}

// 服务商更换：旧商未结清的有效服务保留；接续期间不能重叠报销（在费用申请处拦截）。
export function replacementService(store, actor, body) {
  const elder = store.get('elders', body.elder);
  const overlap = store.state.services.find(s =>
    s.elder === elder.id && s.status !== 'rejected' && s.status !== 'cancelled' &&
    rangesOverlap(s.start, s.end, body.start, body.end) && s.purpose === body.purpose);
  const service = submitService(store, actor, body);
  service.replaces = overlap ? overlap.id : null;
  store.record('REPLACEMENT_ARRANGED', actor.id, { replaces: service.replaces }, { service: service.id, elder: elder.id });
  return service;
}

// 某服务当前是否可继续：结合取消状态与监察暂停范围。
export function continuationStatus(store, service, activePauses) {
  if (service.status === 'cancelled') return { continuable: false, reason: '服务已取消' };
  if (service.status === 'rejected') return { continuable: false, reason: '安排未获批准' };
  const hit = activePauses.find(p => pauseMatchesService(p, service));
  if (hit) return { continuable: false, reason: `监察暂停 ${hit.id} 覆盖该服务/事项`, pause: hit.id };
  return { continuable: true, reason: '未暂停，可继续' };
}

export function pauseMatchesService(pause, service) {
  if (pause.elder !== service.elder) return false;
  if (pause.scopeType === 'service') return pause.scopeRef === service.id;
  if (pause.scopeType === 'provider') return pause.scopeRef === service.provider;
  return pause.scopeRef === service.purpose;
}

export function plannedLines(service) {
  return splitByMonth(service.start, service.end, service.dailyMinor);
}
