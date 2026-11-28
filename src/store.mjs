// 本地 JSON 持久化：全部身份与文书均为合成资料，不连接真实业务系统。
// 采用追加事件日志 + 实体快照，所有决定保留提出方与发生时间，不可物理删除。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowTs } from './dates.mjs';

const EMPTY = () => ({
  seq: 1,
  elders: [],
  actors: [],
  providers: [],
  trusts: [],
  mandates: [],
  capacityDecisions: [],
  evidences: [],
  services: [],
  deliveries: [],
  feeRequests: [],
  paymentInstructions: [],
  pauses: [],
  events: [],
});

export class Store {
  constructor(stateFile, seed = null) {
    this.stateFile = stateFile;
    try {
      this.state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = EMPTY();
      if (seed) this.#seed(seed);
      this.save();
    }
  }

  #seed(records) {
    this.state.elders = records.elders.map(row => ({ ...row }));
    this.state.actors = records.actors.map(row => ({ ...row }));
    this.state.providers = records.providers.map(row => ({ ...row }));
    // 为每个合成服务机构补充一个可登录的机构账号（同样是虚构身份）。
    for (const provider of this.state.providers) {
      this.state.actors.push({ id: `${provider.id.toLowerCase()}-account`, role: 'provider', providerId: provider.id });
    }
    this.state.trusts = records.trusts.map(row => ({
      ...row,
      monthlyLimitMinor: row.monthlyMinor,
      cycle: 'monthly',
    }));
    // serviceDrafts 只作为待办草稿参考，不自动成为已批准安排。
    this.serviceDrafts = records.serviceDrafts.map(row => ({ ...row }));
    this.sourceChanges = records.sourceChanges.map(row => ({ ...row }));
  }

  save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state, null, 1));
    renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  nextId(prefix) {
    const id = `${prefix}-${String(this.state.seq).padStart(4, '0')}`;
    this.state.seq += 1;
    return id;
  }

  find(collection, id) {
    return this.state[collection].find(row => row.id === id) ?? null;
  }

  get(collection, id) {
    const row = this.find(collection, id);
    if (!row) throw new DomainError404(collection, id);
    return row;
  }

  add(collection, row) {
    this.state[collection].push(row);
    return row;
  }

  // 记录不可变业务事实（事件流），每个命令都留痕，可据此追溯授权、交付与付款。
  record(type, actorId, payload, refs = {}) {
    const event = {
      id: this.nextId('EVT'),
      type,
      actorId,
      at: nowTs(),
      refs,
      payload,
    };
    this.state.events.push(event);
    return event;
  }
}

export class DomainError404 extends Error {
  constructor(collection, id) {
    super(`${collection} 中不存在 ${id}`);
    this.name = 'DomainError404';
    this.code = 'NOT_FOUND';
  }
}
