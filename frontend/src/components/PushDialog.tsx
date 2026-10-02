import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SiteImportJob } from '../types';
import { cx, fa } from '../util';
import { Icon } from './Icons';
import Modal from './Modal';
import { errorMessage, useToast } from './Toasts';

const RUNNING = /pend|queue|process|run|pars|upload|start/i;
const READY = /ready|review|done|complet|success|parsed|finish|preview/i;
const FAILED = /fail|error|cancel|reject/i;

function jobPhase(status: string | undefined): 'running' | 'ready' | 'failed' | 'unknown' {
  if (!status) return 'unknown';
  if (FAILED.test(status)) return 'failed';
  if (READY.test(status)) return 'ready';
  if (RUNNING.test(status)) return 'running';
  return 'unknown';
}

/**
 * Sends the Word export into the site's own smart import (POST /push), then polls the
 * site's import job until it is ready for review in the site panel.
 */
export default function PushDialog({
  projectId, onlyApproved, setOnlyApproved, approvedCount, total, errorCount, beforePush, onClose,
}: {
  projectId: string;
  onlyApproved: boolean;
  setOnlyApproved: (v: boolean) => void;
  approvedCount: number;
  total: number;
  errorCount: number;
  beforePush: () => Promise<unknown>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'push' | 'check' | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [job, setJob] = useState<SiteImportJob | null>(null);
  const count = onlyApproved ? approvedCount : total;
  const phase = jobPhase(job?.status);

  // Poll the site job every 3 s while it is still being processed there.
  useEffect(() => {
    if (!job?.id || phase === 'ready' || phase === 'failed') return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const j = await api.importJob(job.id!);
        if (alive) setJob(j);
      } catch {
        /* keep the last known state; the next tick retries */
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [job?.id, phase]);

  const testConnection = async () => {
    setBusy('check');
    setCheck(null);
    try {
      await api.siteCheck();
      setCheck({ ok: true, text: 'اتصال به سایت برقرار است.' });
    } catch (err) {
      setCheck({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    await beforePush();
    setBusy('push');
    setError(null);
    setJob(null);
    try {
      const r = await api.push(projectId, onlyApproved);
      setSent(r.questions ?? count);
      setJob((r.response as SiteImportJob) ?? null);
      toast.success(`${fa(r.questions ?? count)} سؤال به سایت فرستاده شد.`);
    } catch (err) {
      setError(errorMessage(err));
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="ارسال مستقیم به سایت"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" onClick={push} disabled={busy !== null || count === 0} data-testid="push-send">
            <Icon name="send" size={16} /> {busy === 'push' ? 'در حال ارسال…' : `ارسال ${fa(count)} سؤال`}
          </button>
          <button className="btn" onClick={testConnection} disabled={busy !== null} data-testid="push-check">
            {busy === 'check' ? 'در حال بررسی…' : 'تست اتصال'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            بستن
          </button>
        </>
      }
    >
      <p className="small">
        فایل Word همین پروژه به بخش «ورود هوشمند از ورد» سایت فرستاده می‌شود؛ سپس در پنل سایت، سؤال‌ها را بازبینی و ثبت نهایی
        کنید.
      </p>
      <label className="toggle">
        <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} />
        <span>
          فقط سؤال‌های تأییدشده ({fa(approvedCount)} از {fa(total)})
        </span>
      </label>
      {!onlyApproved && errorCount > 0 && <div className="alert alert-warning small">{fa(errorCount)} سؤال هنوز خطا دارد.</div>}
      {check && (
        <div className={cx('alert small', check.ok ? 'alert-success' : 'alert-danger')} data-testid="push-check-result">
          {check.text}
        </div>
      )}
      {error && (
        <div className="alert alert-danger" data-testid="push-result">
          ارسال ناموفق بود: {error}
        </div>
      )}
      {sent !== null && !error && (
        <div className={cx('alert', phase === 'failed' ? 'alert-danger' : 'alert-success')} data-testid="push-result">
          <div>
            <b>{fa(sent)} سؤال</b> به سایت فرستاده شد.
          </div>
          <div className="push-job">
            {phase === 'running' && <span className="save-state save-saving"><i className="save-dot" /> در حال پردازش در سایت…</span>}
            {phase === 'ready' && <span>آماده‌ی بازبینی در پنل سایت ✓</span>}
            {phase === 'failed' && <span>پردازش در سایت ناموفق بود.</span>}
            {phase === 'unknown' && job?.status && <span>وضعیت در سایت: {job.status}</span>}
            {job?.total_items !== undefined && <span className="muted small"> · {fa(job.total_items)} مورد</span>}
            {job?.id !== undefined && <span className="muted small"> · شناسه‌ی کار: {fa(String(job.id))}</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}
