// 意思表示（委托意愿）、代理权限生效与接替、当前决定权判定。
// 三类事实严格区分：老人的意思表示、代理权的生效材料、实际照护服务。
import { DomainError, today, withinWindow, assertDate } from './dates.mjs';

const SCOPES = ['daily-care', 'escort', 'designated-expense'];

function requireScope(scope) {
  if (!SCOPES.includes(scope)) throw new DomainError('VALIDATION', `用途必须是 ${SCOPES.join(' / ')}`);
}

export function registerMandate(store, actor, body) {
  if (actor.role !== 'principal') throw new DomainError('FORBIDDEN', '只有老人本人可登记委托意愿');
  const elder = store.get('elders', body.elder);
  if (actor.elder !== elder.id) throw new DomainError('FORBIDDEN', '只能登记本人的委托意愿');
  assertDate(body.validFrom, 'validFrom');
  assertDate(body.until, 'until');
  if (body.until < body.validFrom) throw new DomainError('VALIDATION', '截止日不能早于生效日');
  if (!Array.isArray(body.scopes) || !body.scopes.length) throw new DomainError('VALIDATION', '至少登记一个事项范围');
  body.scopes.forEach(requireScope);
  const ids = new Set(store.state.actors.map(a => a.id));
  for (const field of ['primary', 'backup']) {
    if (body[field] != null && (!ids.has(body[field]) || store.get('actors', body[field]).role !== 'agent')) {
      throw new DomainError('VALIDATION', `${field} 必须是已登记的代理人员`);
    }
  }
  const mandate = {
    id: store.nextId('MD'),
    elder: elder.id,
    principal: actor.id,
    primary: body.primary ?? null,
    backup: body.backup ?? null,
    scopes: [...body.scopes],
    validFrom: body.validFrom,
    until: body.until,
    status: 'registered',
    createdAt: today(),
  };
  store.add('mandates', mandate);
  store.record('MANDATE_REGISTERED', actor.id, { scopes: mandate.scopes, validFrom: mandate.validFrom, until: mandate.until }, { mandate: mandate.id, elder: elder.id });
  return mandate;
}

// 提交生效材料；提交人不能自行确认。
export function submitEvidence(store, actor, body) {
  assertDate(body.issuedDate ?? today(), 'issuedDate');
  const elder = store.get('elders', body.elder);
  const evidence = {
    id: store.nextId('EVD'),
    elder: elder.id,
    kind: body.kind,
    submittedBy: actor.id,
    issuedDate: body.issuedDate ?? today(),
    summary: body.summary ?? '',
    status: 'submitted',
  };
  store.add('evidences', evidence);
  store.record('EVIDENCE_SUBMITTED', actor.id, { kind: evidence.kind }, { evidence: evidence.id, elder: elder.id });
  return evidence;
}

// 独立见证人员确认文书与生效材料。系统不判断真实监护资格或医疗能力，只登记见证决定。
// decideCapacity: confirm（确认前位不能履职）/ conflict（材料相互矛盾）/ recovered（老人恢复自行决定）
export function decideCapacity(store, actor, body) {
  if (actor.role !== 'witness') throw new DomainError('FORBIDDEN', '只有独立见证人员可确认生效材料');
  const elder = store.get('elders', body.elder);
  const mandate = store.get('mandates', body.mandate);
  if (mandate.elder !== elder.id) throw new DomainError('VALIDATION', '意愿与老人不匹配');
  if (!['confirm', 'conflict', 'recovered'].includes(body.decision)) {
    throw new DomainError('VALIDATION', 'decision 必须是 confirm / conflict / recovered');
  }
  const evidenceIds = body.evidenceIds ?? [];
  for (const eid of evidenceIds) {
    const ev = store.get('evidences', eid);
    if (ev.elder !== elder.id) throw new DomainError('VALIDATION', `材料 ${eid} 不属于该老人`);
    if (ev.submittedBy === actor.id) throw new DomainError('FORBIDDEN', '提交人不能自行确认本人提交的材料');
    ev.status = 'reviewed';
  }
  if (!evidenceIds.length) throw new DomainError('VALIDATION', '确认必须引用至少一份生效材料');

  const decision = {
    id: store.nextId('CPD'),
    elder: elder.id,
    mandate: mandate.id,
    decision: body.decision,
    evidenceIds: [...evidenceIds],
    witness: actor.id,
    disputedScopes: body.decision === 'conflict' ? (body.disputedScopes ?? mandate.scopes) : [],
    at: today(),
  };
  decision.disputedScopes.forEach(requireScope);
  store.add('capacityDecisions', decision);

  if (body.decision === 'confirm') {
    activateAgent(store, actor, mandate, elder);
  } else if (body.decision === 'conflict') {
    // 生效材料相互矛盾：争议事项先暂停代办，未争议的日常服务继续。
    for (const auth of store.state.mandates.filter(m => m.elder === elder.id && ['active', 'partial-suspended', 'succeeded'].includes(m.status))) {
      auth.status = 'partial-suspended';
      auth.suspendedScopes = [...new Set([...(auth.suspendedScopes ?? []), ...decision.disputedScopes])];
    }
    store.record('AUTHORITY_PARTIAL_SUSPENDED', actor.id, { disputedScopes: decision.disputedScopes }, { mandate: mandate.id, elder: elder.id, decision: decision.id });
  } else {
    // 老人恢复自行决定：新申请以本人有效意愿为准；此前合法履职记录不抹去。
    for (const auth of store.state.mandates.filter(m => m.elder === elder.id && ['active', 'partial-suspended', 'succeeded'].includes(m.status))) {
      auth.status = 'principal-restored';
      auth.endedAt = today();
    }
    store.record('PRINCIPAL_RESTORED', actor.id, {}, { mandate: mandate.id, elder: elder.id, decision: decision.id });
  }
  store.record('CAPACITY_DECIDED', actor.id, { decision: body.decision }, { elder: elder.id, mandate: mandate.id, decision: decision.id });
  return decision;
}

function activateAgent(store, witness, mandate, elder) {
  const current = effectiveAuthority(store, elder.id);
  // 矛盾材料导致部分暂停后，新的独立确认恢复同一在任代理，不改变代理顺序。
  if (mandate.status === 'partial-suspended' && mandate.activeAgent) {
    mandate.status = 'active';
    mandate.suspendedScopes = [];
    store.record('AGENT_REINSTATED', witness.id, { agentId: mandate.activeAgent }, { mandate: mandate.id, elder: elder.id });
    return;
  }
  let agentId;
  let order;
  if (!current.agentId) {
    agentId = mandate.primary;
    order = 'primary';
  } else if (current.agentId === mandate.primary) {
    // 备用代理接替：必须有前位不能履职的独立确认，不能由本人自行取得权限。
    if (!mandate.backup) throw new DomainError('VALIDATION', '该意愿未登记备用代理');
    agentId = mandate.backup;
    order = 'backup';
  } else {
    throw new DomainError('CONFLICT', '当前代理已在任，无后续顺序可接替');
  }
  if (!agentId) throw new DomainError('VALIDATION', `意愿未登记${order === 'primary' ? '前位' : '备用'}代理`);
  for (const prior of store.state.mandates.filter(m => m.elder === elder.id && ['active', 'partial-suspended'].includes(m.status))) {
    prior.status = 'succeeded';
    prior.endedAt = today();
  }
  mandate.status = 'active';
  mandate.activeAgent = agentId;
  mandate.activationOrder = order;
  mandate.activatedAt = today();
  mandate.suspendedScopes = [];
  store.record('AGENT_ACTIVATED', witness.id, { agentId, order }, { mandate: mandate.id, elder: elder.id });
}

// 当前谁可以决定哪件事（核心判定视图）。
export function effectiveAuthority(store, elderId, onDate = today()) {
  const mandate = store.state.mandates
    .filter(m => m.elder === elderId)
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  const result = { elderId, onDate, selfDetermining: true, mandate: null, agentId: null, scopes: [], suspendedScopes: [], reasons: [] };
  if (!mandate) {
    result.reasons.push('未登记委托意愿，老人本人决定全部事项');
    return result;
  }
  result.mandate = { id: mandate.id, status: mandate.status, validFrom: mandate.validFrom, until: mandate.until };
  if (!withinWindow(onDate, mandate.validFrom, mandate.until)) {
    result.reasons.push('委托意愿不在适用时间内，由老人本人决定');
    return result;
  }
  if (mandate.status === 'registered') {
    result.reasons.push('意愿已登记但代理尚未经独立见证确认生效，由老人本人决定');
    return result;
  }
  if (mandate.status === 'principal-restored') {
    result.reasons.push('老人已恢复自行决定，新申请以本人有效意愿为准；历史代理履职记录保留');
    return result;
  }
  if (['active', 'partial-suspended'].includes(mandate.status)) {
    result.selfDetermining = false;
    result.agentId = mandate.activeAgent;
    result.suspendedScopes = mandate.suspendedScopes ?? [];
    result.scopes = mandate.scopes.filter(scope => !result.suspendedScopes.includes(scope));
    result.reasons.push(`${mandate.activationOrder === 'backup' ? '备用' : '前位'}代理 ${mandate.activeAgent} 经独立确认生效`);
    if (result.suspendedScopes.length) result.reasons.push(`争议事项暂停代办：${result.suspendedScopes.join('、')}`);
    return result;
  }
  result.reasons.push(`意愿状态为 ${mandate.status}，由老人本人决定`);
  return result;
}

// 某事项当前是否可由某身份决定，返回 { allowed, reason }
export function canDecide(store, actor, elderId, scope, onDate = today()) {
  const auth = effectiveAuthority(store, elderId, onDate);
  if (actor.role === 'principal' && actor.elder === elderId) {
    if (auth.selfDetermining) return { allowed: true, reason: '老人自行决定' };
    return { allowed: false, reason: '老人当前不能自行决定，代理权限已经独立确认生效' };
  }
  if (actor.role === 'agent') {
    if (auth.agentId !== actor.id) return { allowed: false, reason: '该代理当前不在任或顺序未到' };
    if (!auth.scopes.includes(scope)) {
      return auth.suspendedScopes.includes(scope)
        ? { allowed: false, reason: '该事项存在生效材料争议，已暂停代办' }
        : { allowed: false, reason: '委托意愿未涵盖该事项' };
    }
    return { allowed: true, reason: `在任代理且意愿涵盖 ${scope}` };
  }
  return { allowed: false, reason: '该身份无决定权' };
}
