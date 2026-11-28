// 受托付款合作方客户端：对接 support/peer.mjs 的本地协议。
// 合作方受理（accepted）只表示收件，不表示付款到账或责任解除。
export class PartnerClient {
  constructor(baseUrl, config) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.config = config;
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error('合作方服务不可用');
    return res.json();
  }

  // 送达付款指令；超时不代表未受理，调用方应再用 lookup 核实。
  async submitDraw(drawNo, reference, input, drawKey) {
    const payload = { [this.config.group]: [{ [this.config.id]: drawNo, reference, ...input }] };
    let res;
    try {
      res = await fetch(`${this.baseUrl}${this.config.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [this.config.key]: drawKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });
    } catch (error) {
      return { transportError: true, error: String(error.cause?.code ?? error.message) };
    }
    const body = await res.json().catch(() => ({}));
    return { httpStatus: res.status, body };
  }

  async lookup(drawNo) {
    const res = await fetch(`${this.baseUrl}${this.config.lookup}${encodeURIComponent(drawNo)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`合作方查询失败：${res.status}`);
    return res.json();
  }

  // 合作方替身控制接口（仅本地演练用）。
  async setRule(drawNo, mode) {
    const res = await fetch(`${this.baseUrl}/control/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: drawNo, mode }),
      signal: AbortSignal.timeout(4000),
    });
    return res.json();
  }

  async settle(drawNo, status, details = {}) {
    const res = await fetch(`${this.baseUrl}/control/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: drawNo, status, details }),
      signal: AbortSignal.timeout(4000),
    });
    return { httpStatus: res.status, body: await res.json().catch(() => ({})) };
  }
}

// 将一条待核实指令送达合作方，并把受理结果回写（保留待核实状态语义）。
export async function dispatchPayment(store, actor, paymentId, client) {
  if (actor.role !== 'trustee') throw new Error('FORBIDDEN: 只有资金受托方可送达付款指令');
  const pi = store.get('paymentInstructions', paymentId);
  if (pi.status !== 'pending-verification') throw new Error(`CONFLICT: 指令状态 ${pi.status}，不可送达`);
  const drawNo = pi.partnerDrawNo ?? `draw-${pi.id.toLowerCase()}`;
  const drawKey = `key-${pi.id.toLowerCase()}`;
  const result = await client.submitDraw(drawNo, pi.id, {
    elder: pi.elder, service: pi.service, provider: pi.provider,
    purpose: pi.purpose, month: pi.month, amountMinor: pi.amountMinor,
  }, drawKey);

  if (result.transportError) {
    // 超时/断线不代表未受理：主动查询合作方，已持久受理则补写流水号与状态。
    const known = await client.lookup(drawNo);
    if (known) {
      pi.partnerDrawNo = drawNo;
      pi.partnerStatus = known.status;
      if (known.status === 'accepted') pi.status = 'accepted';
      pi.history.push({ status: pi.status, at: new Date().toISOString().slice(0, 10), by: actor.id, note: `断线后查询确认合作方状态：${known.status}` });
      store.record('PAYMENT_DISPATCH_RECOVERED', actor.id, { drawNo, partnerStatus: known.status }, { payment: pi.id });
      return { payment: pi, uncertain: false, recovered: true, partner: known };
    }
    pi.history.push({ status: pi.status, at: new Date().toISOString().slice(0, 10), by: actor.id, note: `送达异常且合作方查无受理，保留待核实：${result.error}` });
    store.record('PAYMENT_DISPATCH_UNCERTAIN', actor.id, { error: result.error }, { payment: pi.id });
    return { payment: pi, uncertain: true, reason: result.error };
  }
  pi.partnerDrawNo = drawNo;
  if (result.httpStatus === 409) {
    pi.history.push({ status: pi.status, at: new Date().toISOString().slice(0, 10), by: actor.id, note: '合作方资料冲突，保留待核实' });
    return { payment: pi, uncertain: true, reason: '合作方编号资料冲突' };
  }
  const op = result.body?.results?.[0];
  pi.partnerStatus = op?.status ?? null;
  if (op?.status === 'accepted') pi.status = 'accepted';
  else if (op?.status === 'rejected') pi.status = 'rejected';
  else pi.status = 'pending-verification'; // 合作方 pending：业务侧保留待核实
  pi.history.push({ status: pi.status, at: new Date().toISOString().slice(0, 10), by: actor.id, partnerStatus: pi.partnerStatus, httpStatus: result.httpStatus });
  store.record('PAYMENT_DISPATCHED', actor.id, { drawNo, partnerStatus: pi.partnerStatus, httpStatus: result.httpStatus }, { payment: pi.id });
  return { payment: pi, uncertain: false, partner: op };
}
