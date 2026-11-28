// 意愿登记、代理生效/接替、矛盾材料、恢复自决的领域测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { DomainError } from '../src/dates.mjs';
import { registerMandate, submitEvidence, decideCapacity, effectiveAuthority, canDecide } from '../src/authority.mjs';

process.env.APP_DATE = '2026-11-28';
const seedFile = new URL('../fixtures/records.json', import.meta.url);

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'auth-'));
  const store = new Store(join(dir, 'state.json'), JSON.parse(await readFile(seedFile, 'utf8')));
  return { store, dir };
}
const actor = (store, id) => store.state.actors.find(a => a.id === id);
const mandateBody = () => ({
  elder: 'EL-1', scopes: ['daily-care', 'escort'], primary: 'agent-a', backup: 'agent-b',
  validFrom: '2026-11-01', until: '2027-01-31',
});

test('意愿登记仅本人可做，登记不等于代理权生效', async () => {
  const { store, dir } = await freshStore();
  assert.throws(() => registerMandate(store, actor(store, 'agent-a'), mandateBody()), e => e.code === 'FORBIDDEN');
  const mandate = registerMandate(store, actor(store, 'elder-1'), mandateBody());
  assert.equal(mandate.status, 'registered');
  const auth = effectiveAuthority(store, 'EL-1');
  assert.equal(auth.selfDetermining, true);
  assert.equal(auth.agentId, null);
  await rm(dir, { recursive: true, force: true });
});

test('前位代理需独立见证确认才生效，提交人不能自行确认', async () => {
  const { store, dir } = await freshStore();
  const mandate = registerMandate(store, actor(store, 'elder-1'), mandateBody());
  const ev = submitEvidence(store, actor(store, 'agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  assert.throws(() => decideCapacity(store, actor(store, 'agent-a'), {
    elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev.id],
  }), e => e.code === 'FORBIDDEN');
  decideCapacity(store, actor(store, 'witness'), {
    elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev.id],
  });
  const auth = effectiveAuthority(store, 'EL-1');
  assert.equal(auth.agentId, 'agent-a');
  assert.equal(canDecide(store, actor(store, 'agent-a'), 'EL-1', 'daily-care').allowed, true);
  assert.equal(canDecide(store, actor(store, 'agent-b'), 'EL-1', 'daily-care').allowed, false);
  await rm(dir, { recursive: true, force: true });
});

test('备用代理只有在前位不能履职且独立确认后才能接替', async () => {
  const { store, dir } = await freshStore();
  const mandate = registerMandate(store, actor(store, 'elder-1'), mandateBody());
  const ev1 = submitEvidence(store, actor(store, 'agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev1.id] });
  // 备用代理自行点确认无效
  assert.throws(() => decideCapacity(store, actor(store, 'agent-b'), {
    elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev1.id],
  }), e => e.code === 'FORBIDDEN');
  const ev2 = submitEvidence(store, actor(store, 'agent-b'), { elder: 'EL-1', kind: 'activation-request', summary: '前位不能履职' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev2.id] });
  assert.equal(effectiveAuthority(store, 'EL-1').agentId, 'agent-b');
  assert.equal(mandate.activeAgent, 'agent-b');
  assert.equal(mandate.activationOrder, 'backup');
  await rm(dir, { recursive: true, force: true });
});

test('生效材料矛盾时争议事项暂停代办，未争议事项继续', async () => {
  const { store, dir } = await freshStore();
  const mandate = registerMandate(store, actor(store, 'elder-1'), mandateBody());
  const ev1 = submitEvidence(store, actor(store, 'agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev1.id] });
  const conflict = submitEvidence(store, actor(store, 'elder-1'), { elder: 'EL-1', kind: 'capacity-conflict' });
  decideCapacity(store, actor(store, 'witness'), {
    elder: 'EL-1', mandate: mandate.id, decision: 'conflict', evidenceIds: [conflict.id], disputedScopes: ['escort'],
  });
  const auth = effectiveAuthority(store, 'EL-1');
  assert.deepEqual(auth.suspendedScopes, ['escort']);
  assert.ok(auth.scopes.includes('daily-care'));
  assert.equal(canDecide(store, actor(store, 'agent-a'), 'EL-1', 'escort').allowed, false);
  assert.equal(canDecide(store, actor(store, 'agent-a'), 'EL-1', 'daily-care').allowed, true);
  await rm(dir, { recursive: true, force: true });
});

test('老人恢复后新申请以本人意愿为准，历史履职事件保留', async () => {
  const { store, dir } = await freshStore();
  const mandate = registerMandate(store, actor(store, 'elder-1'), mandateBody());
  const ev1 = submitEvidence(store, actor(store, 'agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev1.id] });
  const ev2 = submitEvidence(store, actor(store, 'agent-b'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev2.id] });
  const before = store.state.events.filter(e => e.type === 'AGENT_ACTIVATED').length;
  const rec = submitEvidence(store, actor(store, 'supervisor'), { elder: 'EL-1', kind: 'recovery-note' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'recovered', evidenceIds: [rec.id] });
  const auth = effectiveAuthority(store, 'EL-1');
  assert.equal(auth.selfDetermining, true);
  assert.equal(auth.agentId, null);
  assert.equal(store.state.events.filter(e => e.type === 'AGENT_ACTIVATED').length, before);
  assert.ok(store.state.events.some(e => e.type === 'PRINCIPAL_RESTORED'));
  await rm(dir, { recursive: true, force: true });
});

test('矛盾暂停后新的独立确认恢复在任代理，不改变代理顺序', async () => {
  const { store, dir } = await freshStore();
  const mandate = registerMandate(store, actor(store, 'elder-1'), mandateBody());
  const ev1 = submitEvidence(store, actor(store, 'agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev1.id] });
  const conflict = submitEvidence(store, actor(store, 'elder-1'), { elder: 'EL-1', kind: 'capacity-conflict' });
  decideCapacity(store, actor(store, 'witness'), {
    elder: 'EL-1', mandate: mandate.id, decision: 'conflict', evidenceIds: [conflict.id], disputedScopes: ['escort'],
  });
  assert.equal(store.get('mandates', mandate.id).status, 'partial-suspended');
  const clarify = submitEvidence(store, actor(store, 'supervisor'), { elder: 'EL-1', kind: 'activation-request', summary: '争议澄清，代理继续履职' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [clarify.id] });
  const auth = effectiveAuthority(store, 'EL-1');
  assert.equal(auth.agentId, 'agent-a');
  assert.deepEqual(auth.suspendedScopes, []);
  assert.equal(mandate.activationOrder, 'primary');
  await rm(dir, { recursive: true, force: true });
});

test('接替后再发生材料矛盾：备用代理的争议事项也暂停代办', async () => {
  const { store, dir } = await freshStore();
  const mandate = registerMandate(store, actor(store, 'elder-1'), mandateBody());
  const ev1 = submitEvidence(store, actor(store, 'agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev1.id] });
  const ev2 = submitEvidence(store, actor(store, 'agent-b'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev2.id] });
  assert.equal(effectiveAuthority(store, 'EL-1').agentId, 'agent-b');
  const conflict = submitEvidence(store, actor(store, 'elder-1'), { elder: 'EL-1', kind: 'capacity-conflict' });
  decideCapacity(store, actor(store, 'witness'), {
    elder: 'EL-1', mandate: mandate.id, decision: 'conflict', evidenceIds: [conflict.id], disputedScopes: ['escort'],
  });
  const auth = effectiveAuthority(store, 'EL-1');
  assert.equal(auth.agentId, 'agent-b');
  assert.deepEqual(auth.suspendedScopes, ['escort']);
  assert.equal(canDecide(store, actor(store, 'agent-b'), 'EL-1', 'escort').allowed, false);
  assert.equal(canDecide(store, actor(store, 'agent-b'), 'EL-1', 'daily-care').allowed, true);
  await rm(dir, { recursive: true, force: true });
});

test('意愿适用时间之外由老人本人决定', async () => {
  const { store, dir } = await freshStore();
  const mandate = registerMandate(store, actor(store, 'elder-1'), {
    elder: 'EL-1', scopes: ['daily-care'], primary: 'agent-a', validFrom: '2027-02-01', until: '2027-03-01',
  });
  const ev = submitEvidence(store, actor(store, 'agent-a'), { elder: 'EL-1', kind: 'activation-request' });
  decideCapacity(store, actor(store, 'witness'), { elder: 'EL-1', mandate: mandate.id, decision: 'confirm', evidenceIds: [ev.id] });
  const auth = effectiveAuthority(store, 'EL-1', '2026-11-28');
  assert.equal(auth.selfDetermining, true);
  assert.ok(auth.reasons.join('；').includes('不在适用时间'));
  await rm(dir, { recursive: true, force: true });
});

test('非法日期与越权登记被拒绝', async () => {
  const { store, dir } = await freshStore();
  assert.throws(() => registerMandate(store, actor(store, 'elder-1'), {
    elder: 'EL-1', scopes: ['daily-care'], primary: 'agent-a', validFrom: '2026-13-40', until: '2027-01-01',
  }), e => e instanceof DomainError);
  await rm(dir, { recursive: true, force: true });
});
