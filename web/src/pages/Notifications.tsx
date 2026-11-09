import { Bell, CalendarClock, Gavel, HandCoins, MessageCircle, MessageSquareWarning, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMarkRead, useNotifications } from '../api/hooks';
import type { Notification } from '../api/types';
import { Empty, ErrorState, Loading } from '../components/bits';
import { errorText, useToast } from '../components/ui';
import { useI18n } from '../i18n';
import { notificationLink, notificationText } from '../lib/notifications';

function iconFor(n: Notification) {
  const e = n.data?.event;
  if (e === 'receipt' || n.kind === 'payment_to_review') return HandCoins;
  if (e === 'dispute' || n.kind === 'dispute') return MessageSquareWarning;
  if (e === 'legal_ready' || n.kind === 'legal_ready') return Gavel;
  if (e === 'summary') return CalendarClock;
  if (e === 'not_sent' || e === 'send_failed' || e === 'maybe_not_sent' || e === 'promise_broken' || e === 'promise_partly') return TriangleAlert;
  if (e === 'needs_reply' || e === 'reply_held' || e === 'replied_after_last' || n.kind === 'reply') return MessageCircle;
  return Bell;
}

function toneFor(n: Notification) {
  const e = n.data?.event ?? n.kind;
  if (e === 'receipt' || e === 'payment_to_review') return 'green';
  if (e === 'dispute' || e === 'send_failed' || e === 'not_sent' || e === 'promise_broken') return 'red';
  if (e === 'legal_ready') return 'legal';
  if (e === 'promise_partly' || e === 'maybe_not_sent' || e === 'reply_held') return 'amber';
  return 'active';
}

export function NotificationsPage() {
  const { t, relative, formatDate } = useI18n();
  const notes = useNotifications();
  const mark = useMarkRead();
  const toast = useToast();
  const onError = (err: unknown) => toast(errorText(err, t), 'error');

  if (notes.isError) {
    return (
      <div className="page">
        <ErrorState onRetry={() => notes.refetch()} />
      </div>
    );
  }

  const items = notes.data?.items ?? [];
  // Group by day, newest first.
  const days: { day: string; items: Notification[] }[] = [];
  for (const n of items) {
    const day = formatDate(n.created_at, { weekday: 'long', day: 'numeric', month: 'long' });
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(n);
    else days.push({ day, items: [n] });
  }

  return (
    <div className="page notifications">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('notes.title')}</h1>
          {notes.data && <p className="page-sub">{t('notes.unread', { count: notes.data.unread })}</p>}
        </div>
        {notes.data && notes.data.unread > 0 && (
          <div className="page-actions">
            <button type="button" className="btn btn-quiet" disabled={mark.isPending} onClick={() => mark.mutate('all', { onError })}>
              {t('notes.markAll')}
            </button>
          </div>
        )}
      </header>

      {!notes.data ? (
        <section className="panel">
          <Loading rows={6} />
        </section>
      ) : items.length === 0 ? (
        <section className="panel">
          <Empty>{t('notes.empty')}</Empty>
        </section>
      ) : (
        days.map((d) => (
          <section key={d.day} className="panel note-day" aria-label={d.day}>
            <h2 className="note-day-label">{d.day}</h2>
            <ul className="note-list">
              {d.items.map((n) => {
                const Icon = iconFor(n);
                const to = notificationLink(n);
                const text = notificationText(n, t);
                const read = () => {
                  if (!n.read_at) mark.mutate([n.id], { onError });
                };
                return (
                  <li key={n.id} className={`note${n.read_at ? '' : ' note-unread'}`}>
                    <span className={`note-icon tone-${toneFor(n)}`} aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <span className="note-text">
                      {to ? (
                        <Link to={to} onClick={read} className="note-link">
                          {text}
                        </Link>
                      ) : (
                        text
                      )}
                      {!n.read_at && <span className="sr-only">, {t('notes.unread', { count: 1 })}</span>}
                    </span>
                    <time className="note-time" dateTime={n.created_at}>
                      {relative(n.created_at)}
                    </time>
                    {!n.read_at && !to && (
                      <button type="button" className="btn btn-link btn-small" onClick={read}>
                        {t('notes.markRead')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
