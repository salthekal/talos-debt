import { AlertTriangle, Check, CheckCircle2, Landmark, Loader2, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCancelNajizRun, useNajizRun, useStartNajizRun } from '../api/hooks';
import { ApiError } from '../api/source';
import type { LegalRow, NajizCaseStep, NajizRun } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';
import { sum } from '../lib/money';
import { Money } from './bits';
import { Dialog, FormError, errorText } from './ui';

const STEPS: NajizCaseStep[] = ['request_type', 'requester', 'debtor', 'content', 'sending', 'sent'];

/** Seconds left until an ISO time, never below zero. */
function useSecondsLeft(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  if (!until) return null;
  return Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
}

/**
 * One Najiz sign-in that files the chosen approved notes (5.4):
 * confirm, the owner chooses the number in Nafath, then each note is filed
 * step by step. Talos stops before sending anything if Najiz shows something
 * unexpected (Najiz rule 6).
 */
export function NajizFilingDialog({ rows, onClose }: { rows: LegalRow[]; onClose: () => void }) {
  const { t } = useI18n();
  const start = useStartNajizRun();
  const cancel = useCancelNajizRun();
  const [runId, setRunId] = useState<string | null>(null);
  const run = useNajizRun(runId);
  const r = run.data;
  const busy = r && ['starting', 'waiting_nafath', 'working'].includes(r.stage);
  // A note from an earlier try may already be on Najiz: staff check Najiz, then confirm.
  const checkFirst = start.error instanceof ApiError && start.error.code === 'najiz_check_first';
  const [checked, setChecked] = useState(false);

  const title = !r
    ? t('najiz.title', { count: rows.length })
    : r.stage === 'done'
      ? t('najiz.doneTitle', { count: r.cases.length })
      : r.stage === 'stopped'
        ? t('najiz.stoppedTitle')
        : r.stage === 'expired'
          ? t('najiz.expiredTitle')
          : t('najiz.title', { count: r.cases.length });

  const footer = !r ? (
    <>
      <button type="button" className="btn btn-quiet" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={start.isPending || (checkFirst && !checked)}
        onClick={() => start.mutate({ debtIds: rows.map((x) => x.debt_id), checkedNotOnNajiz: checkFirst && checked }, { onSuccess: (x) => setRunId(x.id) })}
      >
        <Smartphone size={17} aria-hidden="true" />
        {t('najiz.start')}
      </button>
    </>
  ) : busy ? (
    <>
      {r.stage === 'working' && <p className="dialog-foot-note muted">{t('najiz.canClose')}</p>}
      {r.stage === 'working' ? (
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          {t('common.close')}
        </button>
      ) : (
        <button type="button" className="btn btn-quiet" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
          {t('najiz.stop')}
        </button>
      )}
    </>
  ) : (
    <>
      {r.stage === 'expired' && (
        <button type="button" className="btn btn-quiet" onClick={() => (setRunId(null), start.reset())}>
          {t('najiz.tryAgain')}
        </button>
      )}
      <button type="button" className="btn btn-primary" onClick={onClose}>
        {t(r.stage === 'done' ? 'najiz.finish' : 'common.close')}
      </button>
    </>
  );

  return (
    <Dialog open onClose={busy && r?.stage !== 'working' ? () => cancel.mutate(r!.id, { onSettled: onClose }) : onClose} title={title} footer={footer} wide>
      {!r ? (
        <Confirm rows={rows} error={start.error ? errorText(start.error, t) : null} checkFirst={checkFirst} checked={checked} onChecked={setChecked} />
      ) : r.stage === 'starting' ? (
        <div className="najiz-wait">
          <Loader2 size={28} className="spin" aria-hidden="true" />
          <p role="status">{t('najiz.opening')}</p>
        </div>
      ) : r.stage === 'waiting_nafath' ? (
        <Nafath run={r} />
      ) : r.stage === 'working' || r.stage === 'done' ? (
        <Progress run={r} />
      ) : r.stage === 'expired' ? (
        <div className="najiz-stop">
          <AlertTriangle size={22} aria-hidden="true" />
          <p>{t('najiz.expired')}</p>
        </div>
      ) : (
        <>
          <div className="najiz-stop" role="alert">
            <AlertTriangle size={22} aria-hidden="true" />
            <p>{t(`najiz.stop.${r.stop_reason ?? 'unexpected_page'}` as MessageKey)}</p>
          </div>
          {r.cases.some((c) => c.step === 'sent' || c.step === 'sending') && <Progress run={r} />}
        </>
      )}
    </Dialog>
  );
}

function Confirm({ rows, error, checkFirst, checked, onChecked }: {
  rows: LegalRow[]; error: string | null; checkFirst: boolean; checked: boolean; onChecked: (v: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="najiz-confirm">
      <p className="dialog-lead">{t('najiz.lead')}</p>
      <ul className="najiz-list">
        {rows.map((x) => (
          <li key={x.debt_id}>
            <span>
              <strong>{x.full_name}</strong>
              <span className="ref">{x.ref_code}</span>
            </span>
            <Money amount={x.amount_outstanding} />
          </li>
        ))}
        {rows.length > 1 && (
          <li className="najiz-list-total">
            <span>{t('legal.total', { count: rows.length })}</span>
            <Money amount={sum(rows.map((x) => x.amount_outstanding))} />
          </li>
        )}
      </ul>
      <ol className="najiz-what">
        <li>{t('najiz.what1')}</li>
        <li>{t('najiz.what2')}</li>
        <li>{t('najiz.what3')}</li>
      </ol>
      <FormError message={error} />
      {checkFirst && (
        <label className="check najiz-checked">
          <input type="checkbox" checked={checked} onChange={(e) => onChecked(e.target.checked)} />
          <span>{t('najiz.checkedNotThere')}</span>
        </label>
      )}
    </div>
  );
}

function Nafath({ run }: { run: NajizRun }) {
  const { t } = useI18n();
  const left = useSecondsLeft(run.nafath_expires_at);
  const mm = left === null ? '' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <div className="nafath">
      <p className="nafath-ask">{t('najiz.nafathAsk')}</p>
      <div className="nafath-num" aria-label={t('najiz.nafathNumber', { n: run.nafath_number ?? '' })}>
        <bdi dir="ltr">{run.nafath_number}</bdi>
      </div>
      {run.nafath_sent ? (
        <p className="nafath-sent">
          <Check size={16} aria-hidden="true" />
          {t('najiz.nafathSent', { last4: run.owner_phone_last4 })}
        </p>
      ) : (
        <p className="nafath-sent muted">{t('najiz.nafathTell')}</p>
      )}
      {left !== null && (
        <p className="nafath-left muted" role="timer" aria-live="off">
          {t('najiz.nafathLeft', { time: mm })}
        </p>
      )}
      <p className="nafath-wait" role="status">
        <Loader2 size={16} className="spin" aria-hidden="true" />
        {t('najiz.nafathWaiting')}
      </p>
    </div>
  );
}

function Progress({ run }: { run: NajizRun }) {
  const { t } = useI18n();
  return (
    <ul className="run-list" aria-live="polite">
      {run.cases.map((c) => {
        const at = STEPS.indexOf(c.step);
        return (
          <li key={c.debt_id} className={`run run-${c.step}`}>
            <div className="run-head">
              <span>
                <strong>{c.full_name}</strong>
                <span className="ref">{c.ref_code}</span>
              </span>
              <Money amount={c.amount} />
            </div>
            <ol className="run-steps" aria-label={t('najiz.stepsOf', { name: c.full_name })}>
              {STEPS.slice(0, -1).map((s, i) => (
                <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>
                  <span className="run-dot" aria-hidden="true">
                    {i < at ? <Check size={12} /> : null}
                  </span>
                  <span>{t(`najiz.step.${s}` as MessageKey)}</span>
                </li>
              ))}
            </ol>
            <p className="run-state">
              {c.step === 'sent' ? (
                <>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  {t('najiz.sent')}
                  <span className="code">
                    <bdi dir="ltr">{c.request_number}</bdi>
                  </span>
                </>
              ) : c.step === 'waiting' ? (
                <span className="muted">{t('najiz.queued')}</span>
              ) : c.step === 'stopped' ? (
                <span className="tone-red">{t('najiz.notSent')}</span>
              ) : c.step === 'sending' && !['starting', 'waiting_nafath', 'working'].includes(run.stage) ? (
                <span className="tone-amber">
                  <AlertTriangle size={15} aria-hidden="true" />
                  {t('najiz.maybeSent')}
                </span>
              ) : (
                <>
                  <Loader2 size={15} className="spin" aria-hidden="true" />
                  {t(`najiz.now.${c.step}` as MessageKey)}
                </>
              )}
            </p>
          </li>
        );
      })}
      {run.stage === 'done' && (
        <li className="run-done">
          <Landmark size={18} aria-hidden="true" />
          {t('najiz.doneHint')}
        </li>
      )}
    </ul>
  );
}
