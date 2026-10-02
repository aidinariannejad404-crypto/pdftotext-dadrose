import { useState } from 'react';
import { api } from '../api';
import type { Project, ReviewMode } from '../types';
import Modal from './Modal';
import { useToast } from './Toasts';

const COPY: Record<ReviewMode, { title: string; body: string; warn: string; button: string; done: string }> = {
  text: {
    title: 'نمایش به‌صورت متن کامل',
    body: 'به‌جای سؤال‌های تستی، متن کامل هر صفحه نمایش داده می‌شود تا آن را صفحه‌به‌صفحه اصلاح، تأیید و به‌صورت Word دانلود کنید. مناسب بانک نکات، جزوه و کتاب.',
    warn: 'هر زمان بخواهید می‌توانید دوباره به حالت سؤال برگردید.',
    button: 'نمایش متن کامل',
    done: 'به حالت متن کامل رفتید.',
  },
  questions: {
    title: 'تبدیل به حالت سؤال',
    body: 'سؤال‌های تستی (صورت سؤال، گزینه‌ها، کلید و پاسخ) از روی متن خوانده‌شده استخراج می‌شوند. مناسب دفترچه‌ی آزمون و کتاب تست.',
    warn: 'استخراج سؤال‌ها از نو انجام می‌شود؛ ویرایش‌ها و تأییدهای قبلی سؤال‌ها از بین می‌رود.',
    button: 'تبدیل به حالت سؤال',
    done: 'به حالت سؤال رفتید.',
  },
};

export default function ModeDialog({
  projectId, target, onClose, onDone,
}: {
  projectId: string;
  target: ReviewMode;
  onClose: () => void;
  onDone: (p: Project) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const c = COPY[target];
  const run = async () => {
    setBusy(true);
    try {
      const p = await api.setMode(projectId, target);
      toast.success(c.done);
      onDone(p);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={c.title}
      tone={target === 'questions' ? 'danger' : 'default'}
      onClose={onClose}
      footer={
        <>
          <button
            className={target === 'questions' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={run}
            disabled={busy}
            data-testid="confirm-mode"
          >
            {busy ? 'در حال تبدیل…' : c.button}
          </button>
          <button className="btn" onClick={onClose}>
            انصراف
          </button>
        </>
      }
    >
      <p>{c.body}</p>
      <div className={target === 'questions' ? 'alert alert-warning small' : 'muted small'}>{c.warn}</div>
    </Modal>
  );
}
