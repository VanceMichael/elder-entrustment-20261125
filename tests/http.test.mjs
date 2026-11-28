// HTTP 集成：真实启动业务应用与合作方服务，验证认证授权、合作方受理、取消核对、可见范围与追溯。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeer } from '../support/peer.mjs';
import { createApp } from '../src/app.mjs';
import { PartnerClient } from '../src/partner-client.mjs';

process.env.APP_DATE = '2026-11-28';
const config = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));
const seedFile = new URL('../fixtures/records.json', import.meta.url);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

async function stack() {
  const dir = await mkdtemp(join(tmpdir(), 'http-'));
  const peer = createPeer(config, join(dir, 'partner.json'));
  const peerBase = await listen(peer);
  const app = createApp({ stateFile: join(dir, 'app.json'), partnerBaseUrl: peerBase, seedFile });
  const appBase = await listen(app.server);
  return { dir, peer, app, appBase, control: new PartnerClient(peerBase, config) };
}

async function api(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Auth-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('未认证请求被拒，登录令牌按角色授权', async () => {
  const s = await stack();
  try {
    assert.equal((await api(s.appBase, null, 'GET', '/me/view')).status, 401);
    const login = await api(s.appBase, null, 'POST', '/auth/login', { actorId: 'elder-1' });
    assert.equal(login.status, 200);
    const bad = await api(s.appBase, 'tok-bogus', 'GET', '/me/view');
    assert.equal(bad.status, 401);
    // 监察不能下单
    const sup = (await api(s.appBase, null, 'POST', '/auth/login', { actorId: 'supervisor' })).json.token;
    const order = await api(s.appBase, sup, 'POST', '/services', { elder: 'EL-1', purpose: 'daily-care', start: '2026-11-28', end: '2026-11-28', dailyMinor: 1 });
    assert.equal(order.status, 403);
  } finally { await close(s.app.server); await close(s.peer); await rm(s.dir, { recursive: true, force: true }); }
});

test('合作方受理到终态同步、取消先核对受理，全链路可追溯', async () => {
  const s = await stack();
  try {
    const tok = {};
    for (const a of ['elder-1', 'agent-a', 'witness', 'trustee', 'supervisor', 'sp-1-account']) {
      tok[a] = (await api(s.appBase, null, 'POST', '/auth/login', { actorId: a })).json.token;
    }
    const md = await api(s.appBase, tok['elder-1'], 'POST', '/mandates', {
      elder: 'EL-1', scopes: ['daily-care'], primary: 'agent-a', validFrom: '2026-11-01', until: '2027-01-31',
    });
    const ev = await api(s.appBase, tok['agent-a'], 'POST', '/evidence', { elder: 'EL-1', kind: 'activation-request' });
    await api(s.appBase, tok.witness, 'POST', '/capacity/decisions', { elder: 'EL-1', mandate: md.json.id, decision: 'confirm', evidenceIds: [ev.json.id] });
    const svc = await api(s.appBase, tok['sp-1-account'], 'POST', '/services', { elder: 'EL-1', purpose: 'daily-care', start: '2026-11-28', end: '2026-11-29', dailyMinor: 5000 });
    await api(s.appBase, tok['agent-a'], 'POST', `/services/${svc.json.id}/decision`, { approve: true });
    const dlv = await api(s.appBase, tok['sp-1-account'], 'POST', '/deliveries', { service: svc.json.id, date: '2026-11-28' });
    await api(s.appBase, tok['agent-a'], 'POST', `/deliveries/${dlv.json.id}/acceptance`, { accepted: true });
    const fee = await api(s.appBase, tok['sp-1-account'], 'POST', '/fee-requests', { service: svc.json.id });
    const pis = await api(s.appBase, tok.trustee, 'POST', `/fee-requests/${fee.json.id}/instructions`, {});
    const pi = pis.json[0];
    const dispatch = await api(s.appBase, tok.trustee, 'POST', `/payments/${pi.id}/dispatch`, {});
    assert.equal(dispatch.json.payment.partnerStatus, 'accepted');
    await s.control.settle(dispatch.json.payment.partnerDrawNo, 'confirmed', { receipt: '合成回单' });
    const synced = await api(s.appBase, tok.trustee, 'POST', `/payments/${pi.id}/sync`, {});
    assert.equal(synced.json.status, 'confirmed');

    // 取消时先核对合作方
    const cancel = await api(s.appBase, tok['agent-a'], 'POST', `/services/${svc.json.id}/cancel`, { reason: '调整', checkPartner: true });
    assert.deepEqual(cancel.json.accepted, [pi.id]);
    assert.ok(cancel.json.partnerFindings.some(f => f.partnerStatus === 'confirmed'));

    // 追溯
    const trace = await api(s.appBase, tok.supervisor, 'GET', `/trace/${svc.json.id}`);
    assert.equal(trace.json.deliveries.length, 1);
    assert.equal(trace.json.payments[0].id, pi.id);
    assert.ok(trace.json.eventChain.some(e => e.type === 'PAYMENT_DISPATCHED'));

    // 决定权查询
    const makers = await api(s.appBase, null, 'GET', '/decisions/EL-1');
    assert.ok(makers.json.decisionMakers.length >= 1);
  } finally { await close(s.app.server); await close(s.peer); await rm(s.dir, { recursive: true, force: true }); }
});

test('合作方断线时指令保留待核实，事后查询确认受理', async () => {
  const s = await stack();
  try {
    const tok = {};
    for (const a of ['elder-1', 'agent-a', 'witness', 'trustee', 'sp-1-account']) {
      tok[a] = (await api(s.appBase, null, 'POST', '/auth/login', { actorId: a })).json.token;
    }
    const md = await api(s.appBase, tok['elder-1'], 'POST', '/mandates', {
      elder: 'EL-1', scopes: ['daily-care'], primary: 'agent-a', validFrom: '2026-11-01', until: '2027-01-31',
    });
    const ev = await api(s.appBase, tok['agent-a'], 'POST', '/evidence', { elder: 'EL-1', kind: 'activation-request' });
    await api(s.appBase, tok.witness, 'POST', '/capacity/decisions', { elder: 'EL-1', mandate: md.json.id, decision: 'confirm', evidenceIds: [ev.json.id] });
    const svc = await api(s.appBase, tok['sp-1-account'], 'POST', '/services', { elder: 'EL-1', purpose: 'daily-care', start: '2026-11-28', end: '2026-11-28', dailyMinor: 5000 });
    await api(s.appBase, tok['agent-a'], 'POST', `/services/${svc.json.id}/decision`, { approve: true });
    const dlv = await api(s.appBase, tok['sp-1-account'], 'POST', '/deliveries', { service: svc.json.id, date: '2026-11-28' });
    await api(s.appBase, tok['agent-a'], 'POST', `/deliveries/${dlv.json.id}/acceptance`, { accepted: true });
    const fee = await api(s.appBase, tok['sp-1-account'], 'POST', '/fee-requests', { service: svc.json.id });
    const [pi] = (await api(s.appBase, tok.trustee, 'POST', `/fee-requests/${fee.json.id}/instructions`, {})).json;
    await s.control.setRule(`draw-${pi.id.toLowerCase()}`, 'accepted_disconnect');
    const dispatch = await api(s.appBase, tok.trustee, 'POST', `/payments/${pi.id}/dispatch`, {});
    assert.equal(dispatch.json.recovered, true);
    assert.equal(dispatch.json.payment.partnerStatus, 'accepted');
    const synced = await api(s.appBase, tok.trustee, 'POST', `/payments/${pi.id}/sync`, {});
    assert.equal(synced.json.status, 'accepted');
  } finally { await close(s.app.server); await close(s.peer); await rm(s.dir, { recursive: true, force: true }); }
});

test('角色可见范围：服务商只见自身业务，监察可查依据', async () => {
  const s = await stack();
  try {
    const t1 = (await api(s.appBase, null, 'POST', '/auth/login', { actorId: 'sp-1-account' })).json.token;
    const t2 = (await api(s.appBase, null, 'POST', '/auth/login', { actorId: 'sp-2-account' })).json.token;
    const ts = (await api(s.appBase, null, 'POST', '/auth/login', { actorId: 'supervisor' })).json.token;
    // 两服务商各提交一项安排
    await api(s.appBase, t1, 'POST', '/services', { elder: 'EL-1', purpose: 'daily-care', start: '2026-11-28', end: '2026-11-28', dailyMinor: 100 });
    await api(s.appBase, t2, 'POST', '/services', { elder: 'EL-1', purpose: 'escort', start: '2026-11-28', end: '2026-11-28', dailyMinor: 100 });
    const view1 = (await api(s.appBase, t1, 'GET', '/me/view')).json;
    const view2 = (await api(s.appBase, t2, 'GET', '/me/view')).json;
    assert.ok(view1.services.every(x => x.provider === 'SP-1'));
    assert.ok(view2.services.every(x => x.provider === 'SP-2'));
    assert.equal(view1.services.length, 1);
    // 服务商不能拉全量事件流
    assert.equal((await api(s.appBase, t1, 'GET', '/events')).status, 403);
    const supView = (await api(s.appBase, ts, 'GET', '/me/view')).json;
    assert.ok(supView.services.length >= 2);
    assert.ok(Array.isArray(supView.pauses));
  } finally { await close(s.app.server); await close(s.peer); await rm(s.dir, { recursive: true, force: true }); }
});

test('应用重启后状态保留', async () => {
  const s = await stack();
  try {
    const t = (await api(s.appBase, null, 'POST', '/auth/login', { actorId: 'elder-1' })).json.token;
    const md = await api(s.appBase, t, 'POST', '/mandates', {
      elder: 'EL-1', scopes: ['daily-care'], primary: 'agent-a', validFrom: '2026-11-01', until: '2027-01-31',
    });
    await close(s.app.server);
    const app2 = createApp({ stateFile: join(s.dir, 'app.json'), partnerBaseUrl: s.appBase, seedFile });
    const base2 = await listen(app2.server);
    const list = await api(base2, null, 'GET', '/mandates');
    assert.ok(list.json.some(m => m.id === md.json.id));
    await close(app2.server);
  } finally { await close(s.peer); await rm(s.dir, { recursive: true, force: true }); }
});
