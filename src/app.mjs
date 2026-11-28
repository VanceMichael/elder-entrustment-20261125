// HTTP 路由与主入口：零第三方依赖，仅用 node:http。所有文书为本地合成资料。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DomainError } from './dates.mjs';
import { Store } from './store.mjs';
import { buildIdentity, requireRole } from './auth.mjs';
import { registerMandate, submitEvidence, decideCapacity, effectiveAuthority } from './authority.mjs';
import {
  submitService, decideService, addDelivery, acceptDelivery,
  cancelService, replacementService,
} from './services.mjs';
import { createPause, liftPause } from './supervision.mjs';
import {
  createFeeRequest, issuePaymentInstructions, reevaluateInstruction,
  syncFromPartner, cancelServiceFlow, registerReturn, quotaView,
} from './payments.mjs';
import { dispatchPayment, PartnerClient } from './partner-client.mjs';
import { decisionMakers, servicesContinuation, explainPayment, traceService, visibleState } from './views.mjs';

export function createApp({ stateFile, partnerBaseUrl, seedFile = null }) {
  const seed = seedFile ? JSON.parse(readFileSync(seedFile, 'utf8')) : null;
  const store = new Store(stateFile, seed);
  const identity = buildIdentity(store);
  const partnerConfig = JSON.parse(readFileSync(new URL('../fixtures/partner.json', import.meta.url), 'utf8'));
  const partner = new PartnerClient(partnerBaseUrl, partnerConfig);

  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return send(res, 413, { error: '资料过大' });
      }
      const body = raw ? JSON.parse(raw) : {};
      const who = () => requireRole(identity.resolve(req.headers['x-auth-token']), null);
      const id = suffix => decodeURIComponent(p.slice(suffix.length));

      if (req.method === 'GET' && p === '/health') return send(res, 200, { status: 'ok', app: 'elder-entrustment', synthetic: true });
      if (req.method === 'POST' && p === '/auth/login') {
        return send(res, 200, identity.login(body.actorId));
      }

      // 登记意愿、确认生效、监督暂停由不同授权完成；提交人不能自行确认。
      if (req.method === 'POST' && p === '/mandates') return send(res, 201, withSave(registerMandate(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['principal']), body)));
      if (req.method === 'GET' && p === '/mandates') return send(res, 200, store.state.mandates);
      if (req.method === 'POST' && p === '/evidence') return send(res, 201, withSave(submitEvidence(store, who(), body)));
      if (req.method === 'POST' && p === '/capacity/decisions') return send(res, 201, withSave(decideCapacity(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['witness']), body)));
      if (req.method === 'GET' && p.startsWith('/authority/')) {
        const elderId = id('/authority/');
        return send(res, 200, effectiveAuthority(store, elderId, url.searchParams.get('date') ?? undefined));
      }

      // 照护安排与交付
      if (req.method === 'POST' && p === '/services') return send(res, 201, withSave(submitService(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['provider']), body)));
      if (req.method === 'POST' && p === '/services/replacement') return send(res, 201, withSave(replacementService(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['provider']), body)));
      if (req.method === 'GET' && p === '/services') return send(res, 200, store.state.services);
      if (req.method === 'POST' && p.match(/\/services\/[^/]+\/decision$/)) {
        const serviceId = p.split('/')[2];
        return send(res, 200, withSave(decideService(store, who(), serviceId, body.approve, body.note)));
      }
      if (req.method === 'POST' && p === '/deliveries') return send(res, 201, withSave(addDelivery(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['provider']), body)));
      if (req.method === 'POST' && p.match(/\/deliveries\/[^/]+\/acceptance$/)) {
        const deliveryId = p.split('/')[2];
        return send(res, 200, withSave(acceptDelivery(store, who(), deliveryId, body.accepted, body.note)));
      }
      if (req.method === 'POST' && p.match(/\/services\/[^/]+\/cancel$/)) {
        const serviceId = p.split('/')[2];
        if (body.checkPartner === true) {
          const result = await cancelServiceFlow(store, who(), serviceId, body.reason, partner);
          store.save();
          return send(res, 200, result);
        }
        return send(res, 200, withSave(cancelService(store, who(), serviceId, body.reason)));
      }

      // 费用申请与付款
      if (req.method === 'POST' && p === '/fee-requests') return send(res, 201, withSave(createFeeRequest(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['provider']), body)));
      if (req.method === 'GET' && p === '/fee-requests') return send(res, 200, store.state.feeRequests);
      if (req.method === 'POST' && p.match(/\/fee-requests\/[^/]+\/instructions$/)) {
        const feeId = p.split('/')[2];
        return send(res, 201, withSave(issuePaymentInstructions(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['trustee']), feeId)));
      }
      if (req.method === 'POST' && p.match(/\/payments\/[^/]+\/dispatch$/)) {
        const paymentId = p.split('/')[2];
        const result = await dispatchPayment(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['trustee']), paymentId, partner);
        store.save();
        return send(res, 200, result);
      }
      if (req.method === 'POST' && p.match(/\/payments\/[^/]+\/reevaluate$/)) {
        const paymentId = p.split('/')[2];
        return send(res, 200, withSave(reevaluateInstruction(store, who(), paymentId)));
      }
      if (req.method === 'POST' && p.match(/\/payments\/[^/]+\/sync$/)) {
        const paymentId = p.split('/')[2];
        const result = await syncFromPartner(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['trustee']), paymentId, partner);
        store.save();
        return send(res, 200, result);
      }
      if (req.method === 'POST' && p.match(/\/payments\/[^/]+\/return$/)) {
        const paymentId = p.split('/')[2];
        return send(res, 200, withSave(registerReturn(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['trustee']), paymentId, body.details)));
      }
      if (req.method === 'GET' && p.match(/^\/payments\/[^/]+$/)) {
        const paymentId = id('/payments/');
        return send(res, 200, explainPayment(store, paymentId));
      }
      if (req.method === 'GET' && p === '/payments') return send(res, 200, store.state.paymentInstructions);
      if (req.method === 'GET' && p.startsWith('/quota/')) return send(res, 200, quotaView(store, id('/quota/')));

      // 监察
      if (req.method === 'POST' && p === '/pauses') return send(res, 201, withSave(createPause(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['supervisor']), body)));
      if (req.method === 'POST' && p.match(/\/pauses\/[^/]+\/lift$/)) {
        const pauseId = p.split('/')[2];
        return send(res, 200, withSave(liftPause(store, requireRole(identity.resolve(req.headers['x-auth-token']), ['supervisor']), pauseId, body.reason)));
      }
      if (req.method === 'GET' && p === '/pauses') return send(res, 200, store.state.pauses);

      // 查询与追溯
      if (req.method === 'GET' && p.startsWith('/decisions/')) return send(res, 200, decisionMakers(store, id('/decisions/')));
      if (req.method === 'GET' && p.startsWith('/continuation/')) return send(res, 200, servicesContinuation(store, id('/continuation/')));
      if (req.method === 'GET' && p.startsWith('/trace/')) return send(res, 200, traceService(store, id('/trace/')));
      if (req.method === 'GET' && p === '/me/view') return send(res, 200, visibleState(store, who()));
      if (req.method === 'GET' && p === '/events') {
        const actor = who();
        if (actor.role === 'provider') return send(res, 403, { error: '服务机构不开放全量事件流，只能查看自身业务对象' });
        return send(res, 200, store.state.events);
      }

      return send(res, 404, { error: '没有对应的业务接口' });
    } catch (error) {
      const status = error.code === 'NOT_FOUND' ? 404
        : error.code === 'UNAUTHORIZED' ? 401
        : error.code === 'FORBIDDEN' ? 403
        : error.code === 'VALIDATION' ? 400
        : error.code === 'CONFLICT' ? 409
        : error instanceof SyntaxError ? 400 : 500;
      send(res, status, { error: error instanceof SyntaxError ? 'JSON 格式不符' : error.message });
    }
  });

  function withSave(value) {
    store.save();
    return value;
  }

  return { server, store, identity, partner };
}
