import { createHmac, timingSafeEqual } from 'node:crypto';
import { Store, fail, id, now } from './db.js';
import { ActualBridge, Serial, buildTransaction, type Candidate } from './actual.js';
import { Recognizer } from './models.js';
import { draftSchema, allocate, validateForSubmit, type Draft, type Receipt } from '../shared/receipt.js';
import { cleanupImages } from './images.js';
import type { RecognitionProgress } from '../shared/progress.js';
export class ReceiptService {
  private progress = new Map<string, RecognitionProgress>();
  private submissionQueue = new Serial();
  private recognizing = false;
  private cleaning = false;
  private recovering = false;
  constructor(public store: Store, public actual: ActualBridge, public recognizer: Recognizer, private key: Buffer) {}
  receipt(receiptID: string): Receipt {
    const row = this.store.get('SELECT * FROM receipts WHERE id=?', receiptID); if (!row || row.status === 'deleting') fail('小票记录不存在', 404);
    const draft = draftSchema.parse(JSON.parse(row.draft));
    const submission = this.store.get('SELECT snapshot FROM submissions WHERE receipt_id=?', receiptID);
    const notesFormatVersion = submission ? JSON.parse(submission.snapshot).notesFormatVersion ?? 1 : 2;
    return { ...row, draft, notesFormatVersion, recognition: this.progress.get(receiptID) || null, images: this.store.all('SELECT id,position FROM images WHERE receipt_id=? ORDER BY position', receiptID), allocation: allocate(draft) };
  }
  save(receiptID: string, version: number, draft: Draft) {
    const row = this.receipt(receiptID);
    draft.originalCurrency = row.draft.originalCurrency;
    if (!['draft', 'failed'].includes(row.status)) fail('小票正在处理或已入账', 409);
    if (this.store.get('SELECT id FROM submissions WHERE receipt_id=?', receiptID)) fail('请先核验既有提交', 409);
    if (!this.store.run("UPDATE receipts SET draft=?,version=version+1,status='draft',updated_at=?,error=NULL WHERE id=? AND version=? AND status IN ('draft','failed')", JSON.stringify(draft), now(), receiptID, version).changes) fail('另一页面已修改草稿，请刷新后核对', 409);
    return this.receipt(receiptID);
  }
  enqueueRecognition(receiptID: string, version: number, replace: boolean) {
    return this.store.tx(() => {
      const r = this.receipt(receiptID);
      if (r.version !== version || !['draft', 'failed'].includes(r.status)) fail('草稿状态已更新，请刷新', 409);
      if (r.draft.items.length && !replace) fail('请确认替换已编辑的商品内容', 409);
      if (!r.images.length) fail('请先上传小票图片');
      if (!r.draft.account) fail('请先选择付款账户并保存草稿');
      if (!this.store.setting('model')) fail('请先在设置中选择识别来源', 422);
      if (this.store.get('SELECT id FROM submissions WHERE receipt_id=?', receiptID)) fail('请核验已有提交', 409);
      const job = id(); this.store.run("INSERT INTO jobs VALUES(?,?,?,'queued',NULL,?)", job, receiptID, version, now());
      this.store.run("UPDATE receipts SET status='queued',error=NULL,updated_at=? WHERE id=?", now(), receiptID); return { jobId: job };
    });
  }
  private fingerprint(r: Receipt, candidates: Candidate[]) { return createHmac('sha256', this.key).update(JSON.stringify([r.id, r.version, r.draft, this.actual.connection(), candidates.map(c => c.id).sort()])).digest('hex'); }
  async duplicates(receiptID: string, version: number) {
    const connection = this.actual.connection();
    const r = this.receipt(receiptID); if (r.version !== version) fail('草稿已更新', 409);
    const catalog = await this.actual.catalog(); const checked = validateForSubmit(r.draft, catalog.accounts, catalog.categories, catalog.currency);
    if (checked.errors.length) fail(checked.errors.join('；'), 422);
    const candidates = await this.actual.duplicates(r.draft);
    if (this.actual.connection() !== connection) fail('账本连接已变化，请重新检查', 409);
    return { candidates, token: this.fingerprint(r, candidates) };
  }
  submit(receiptID: string, version: number, submissionID: string, duplicateToken?: string) {
    return this.submissionQueue.run(async () => {
      const existing = this.store.get('SELECT * FROM submissions WHERE receipt_id=?', receiptID);
      if (existing) { if (existing.id !== submissionID || existing.version !== version) fail('提交标识或草稿版本不匹配', 409); return this.receipt(receiptID); }
      const r = this.receipt(receiptID);
      if (r.submission_id !== submissionID || r.version !== version || !['draft', 'failed'].includes(r.status)) fail('草稿状态或提交标识已更新', 409);
      const connection = this.actual.connection();
      const catalog = await this.actual.catalog(); const allocation = validateForSubmit(r.draft, catalog.accounts, catalog.categories, catalog.currency);
      if (allocation.errors.length) fail(allocation.errors.join('；'), 422);
      const candidates = await this.actual.duplicates(r.draft);
      if (candidates.length) {
        const wanted = Buffer.from(this.fingerprint(r, candidates)), given = Buffer.from(duplicateToken || '');
        if (wanted.length !== given.length || !timingSafeEqual(wanted, given)) fail('发现相同金额的已有交易，请重新检查重复候选并确认', 409);
      }
      const time = now();
      if (this.actual.connection() !== connection) fail('账本连接已变化，请重新检查', 409);
      this.store.tx(() => {
        if (!this.store.run("UPDATE receipts SET status='submitting',updated_at=?,error=NULL WHERE id=? AND version=? AND status IN ('draft','failed')", time, receiptID, version).changes) fail('草稿已被另一页面修改', 409);
        this.store.run("INSERT INTO submissions VALUES(?,?,?,'queued',?,?,?,?,NULL,?,?)", submissionID, receiptID, version, JSON.stringify({ notesFormatVersion: 2, draft: r.draft, duplicateIds: candidates.map(c => c.id) }), JSON.stringify(allocation), id(), this.actual.connection(), time, time);
      });
      return this.receipt(receiptID);
    });
  }
  private complete(s: any, transactionID: string) {
    this.store.tx(() => {
      this.store.run("UPDATE submissions SET status='synced',error=NULL,updated_at=? WHERE id=?", now(), s.id);
      this.store.run("UPDATE receipts SET status='posted',transaction_id=?,cleanup='pending',error=NULL,updated_at=? WHERE id=?", transactionID, now(), s.receipt_id);
      this.store.run('INSERT OR IGNORE INTO cleanup_queue(receipt_id,next_at) VALUES(?,?)', s.receipt_id, now());
    });
  }
  private uncertain(s: any, message: string) {
    this.store.tx(() => { this.store.run("UPDATE submissions SET status='uncertain',error=?,updated_at=? WHERE id=?", message, now(), s.id); this.store.run("UPDATE receipts SET status='uncertain',error=?,updated_at=? WHERE id=?", message, now(), s.receipt_id); });
  }
  async verify(receiptID: string) {
    return this.submissionQueue.run(async () => {
      const s = this.store.get('SELECT * FROM submissions WHERE receipt_id=?', receiptID); if (!s) fail('尚无提交记录');
      if (s.status === 'synced') return this.receipt(receiptID);
      if (s.connection !== this.actual.connection()) fail('请恢复提交时使用的 Actual 账本连接', 409);
      const result = await this.actual.verify(buildTransaction(JSON.parse(s.snapshot).draft, JSON.parse(s.allocation), s.id, s.transaction_id, JSON.parse(s.snapshot).notesFormatVersion ?? 1));
      if (result.valid && result.id) this.complete(s, result.id);
      else this.uncertain(s, result.found ? '已找到关联交易，金额或明细与提交记录有差异，请在 Actual 中核对' : '远端暂未找到关联交易，原提交标识已保留；核对 Actual 后可重试此提交');
      return this.receipt(receiptID);
    });
  }
  retrySubmission(receiptID: string) {
    return this.submissionQueue.run(async () => {
      const s = this.store.get('SELECT * FROM submissions WHERE receipt_id=?', receiptID); if (!s || s.status !== 'uncertain') fail('请先核验提交状态', 409);
      if (s.connection !== this.actual.connection()) fail('请恢复原账本连接', 409);
      // Flush surviving local messages, then download a fresh verification copy before any retry.
      await this.actual.catalog();
      const result = await this.actual.verify(buildTransaction(JSON.parse(s.snapshot).draft, JSON.parse(s.allocation), s.id, s.transaction_id, JSON.parse(s.snapshot).notesFormatVersion ?? 1));
      if (result.valid && result.id) { this.complete(s, result.id); return this.receipt(receiptID); }
      if (result.found) fail('关联交易存在，请在 Actual 中人工核对', 409);
      const candidates = await this.actual.duplicates(JSON.parse(s.snapshot).draft);
      if (candidates.some(c => !JSON.parse(s.snapshot).duplicateIds.includes(c.id))) fail('出现新的重复候选，请在 Actual 中人工核对', 409);
      this.store.tx(() => { this.store.run("UPDATE submissions SET status='queued',error=NULL,updated_at=? WHERE id=?", now(), s.id); this.store.run("UPDATE receipts SET status='submitting',error=NULL WHERE id=?", receiptID); });
      return this.receipt(receiptID);
    });
  }
  recover() {
    this.store.tx(() => {
      this.store.run("UPDATE receipts SET status='failed',error='识别因服务重启而中断，请重新识别' WHERE status='recognizing'");
      this.store.run("UPDATE jobs SET status='failed',error='服务重启' WHERE status='running'");
      this.store.run("UPDATE receipts SET status='failed',error='上传中断，请检查图片后重试' WHERE status='uploading'");
      this.store.run("UPDATE submissions SET status='uncertain' WHERE status='writing'");
      this.store.run("UPDATE receipts SET status='uncertain',error='服务重启，请核验提交状态' WHERE id IN (SELECT receipt_id FROM submissions WHERE status='uncertain')");
      this.store.run('DELETE FROM challenges WHERE expires<?', now()); this.store.run('DELETE FROM sessions WHERE expires<?', now());
    });
  }
  async tick() {
    if (!this.recognizing) { this.recognizing = true; void this.runRecognition().catch(() => {}).finally(() => { this.recognizing = false; }); }
    if (!this.recovering) { this.recovering = true; void this.submissionQueue.run(() => this.runSubmission()).catch(() => {}).finally(() => { this.recovering = false; }); }
    if (!this.cleaning) { this.cleaning = true; void cleanupImages(this.store).catch(() => {}).finally(() => { this.cleaning = false; }); }
  }
  private async runRecognition() {
    const job = this.store.get("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"); if (!job) return;
    const startedAt = now();
    try {
      this.store.tx(() => { this.store.run("UPDATE jobs SET status='running' WHERE id=?", job.id); this.store.run("UPDATE receipts SET status='recognizing' WHERE id=?", job.receipt_id); });
      const r = this.receipt(job.receipt_id), catalog = await this.actual.catalog();
      const paths = this.store.all('SELECT thumbnail FROM images WHERE receipt_id=? ORDER BY position', r.id).map(i => i.thumbnail);
      const draft = await this.recognizer.recognize(paths, catalog.categories, catalog.currency, (stage, model) => {
        this.progress.set(r.id, { ...model, stage, startedAt });
      }); draft.account = r.draft.account;
      this.store.tx(() => { this.store.run("UPDATE receipts SET draft=?,status='draft',version=version+1,error=NULL,updated_at=? WHERE id=? AND version=?", JSON.stringify(draft), now(), r.id, job.version); this.store.run("UPDATE jobs SET status='done' WHERE id=?", job.id); });
    } catch (e) { const message = safeError(e); this.store.tx(() => { this.store.run("UPDATE receipts SET status='failed',error=?,updated_at=? WHERE id=?", message, now(), job.receipt_id); this.store.run("UPDATE jobs SET status='failed',error=? WHERE id=?", message, job.id); }); }
    finally { this.progress.delete(job.receipt_id); }
  }
  private async runSubmission() {
    const s = this.store.get("SELECT * FROM submissions WHERE status='queued' ORDER BY created_at LIMIT 1"); if (!s) return;
    try {
      if (this.actual.connection() !== s.connection) throw new Error('账本连接已变更，请恢复原连接后核验');
      const { draft, duplicateIds } = JSON.parse(s.snapshot);
      const candidates = await this.actual.duplicates(draft);
      if (candidates.some(c => !duplicateIds.includes(c.id))) { this.uncertain(s, '出现新的同金额交易，请先核验重复候选'); return; }
      this.store.run("UPDATE submissions SET status='writing',updated_at=? WHERE id=?", now(), s.id);
      const transaction = buildTransaction(draft, JSON.parse(s.allocation), s.id, s.transaction_id, JSON.parse(s.snapshot).notesFormatVersion ?? 1);
      await this.actual.write(transaction);
      const result = await this.actual.verify(transaction);
      if (!result.valid || !result.id) throw new Error('远端回读结果待核验');
      this.complete(s, result.id);
    } catch (e) { this.uncertain(s, safeError(e)); }
  }
}
export function safeError(error: unknown) {
  if (error instanceof Error && /^[\u3400-\u9fff]|^(Actual|Codex)/.test(error.message)) return error.message.slice(0, 400);
  return '处理失败，请检查连接、模型额度和输入后重试';
}
