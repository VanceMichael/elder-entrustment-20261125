// 本地合成身份认证：令牌仅在本机演练使用，不代表真实身份核验。
import { DomainError } from './dates.mjs';

// 服务机构账号映射到 provider 实体；其余角色直接使用 actors 资料。
export function buildIdentity(store) {
  const tokens = new Map();
  const login = actorId => {
    const actor = store.state.actors.find(a => a.id === actorId);
    if (!actor) throw new DomainError('VALIDATION', '身份资料不存在');
    let identity = { ...actor };
    if (actor.role === 'provider') {
      const provider = store.state.providers.find(p => p.id === actor.providerId);
      if (!provider) throw new DomainError('VALIDATION', '服务机构资料不存在');
      identity.providerId = provider.id;
    }
    const token = `tok-${actorId}-${Math.random().toString(36).slice(2, 10)}`;
    tokens.set(token, identity);
    return { token, actor: identity };
  };
  const resolve = token => tokens.get(token) ?? null;
  return { login, resolve };
}

export function requireRole(identity, roles) {
  if (!identity) throw new DomainError('UNAUTHORIZED', '缺少或无效的 X-Auth-Token');
  if (roles && !roles.includes(identity.role)) {
    throw new DomainError('FORBIDDEN', `该接口仅允许 ${roles.join(' / ')}`);
  }
  return identity;
}
