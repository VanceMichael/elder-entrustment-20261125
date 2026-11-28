// 监察暂停：监察人员可暂停存在争议的支出；不能冒充老人下单。
import { DomainError, today } from './dates.mjs';

const SCOPE_TYPES = {
  service: 'services',
  provider: 'providers',
  scope: null, // 事项用途，如 daily-care
};

export function createPause(store, actor, body) {
  if (actor.role !== 'supervisor') throw new DomainError('FORBIDDEN', '只有监察人员可下达暂停');
  const elder = store.get('elders', body.elder);
  if (!Object.hasOwn(SCOPE_TYPES, body.scopeType)) throw new DomainError('VALIDATION', 'scopeType 必须是 service / provider / scope');
  if (body.scopeType === 'service') {
    const service = store.get('services', body.scopeRef);
    if (service.elder !== elder.id) throw new DomainError('VALIDATION', '暂停服务与老人不匹配');
  } else if (body.scopeType === 'provider') {
    store.get('providers', body.scopeRef);
  }
  const pause = {
    id: store.nextId('PSP'),
    elder: elder.id,
    scopeType: body.scopeType,
    scopeRef: body.scopeRef,
    reason: body.reason ?? '',
    status: 'active',
    createdBy: actor.id,
    createdAt: today(),
    liftedAt: null,
    liftReason: null,
  };
  store.add('pauses', pause);
  store.record('PAUSE_CREATED', actor.id, { scopeType: pause.scopeType, scopeRef: pause.scopeRef, reason: pause.reason }, { pause: pause.id, elder: elder.id });
  return pause;
}

export function liftPause(store, actor, pauseId, reason) {
  if (actor.role !== 'supervisor') throw new DomainError('FORBIDDEN', '只有监察人员可解除暂停');
  const pause = store.get('pauses', pauseId);
  if (pause.status !== 'active') throw new DomainError('CONFLICT', '暂停不在生效中');
  pause.status = 'lifted';
  pause.liftedAt = today();
  pause.liftReason = reason ?? '';
  store.record('PAUSE_LIFTED', actor.id, { reason }, { pause: pauseId, elder: pause.elder });
  return pause;
}

export function activePauses(store, elderId = null) {
  return store.state.pauses.filter(p => p.status === 'active' && (elderId === null || p.elder === elderId));
}

export function pauseMatches(pause, { service, provider, scope, elderId }) {
  if (pause.elder !== elderId) return false;
  if (pause.scopeType === 'service') return pause.scopeRef === service;
  if (pause.scopeType === 'provider') return pause.scopeRef === provider;
  return pause.scopeRef === scope;
}
