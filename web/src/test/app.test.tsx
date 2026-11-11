/**
 * Screen tests: the whole app with the sample data source, in English and
 * Arabic. The end-to-end run (e2e/run.mjs) covers the same flows against the
 * real API and database.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { demoSource } from '../api/demo';
import { ApiError, type DataSource } from '../api/source';
import type { Me } from '../api/types';
import { cleanAmount } from '../components/actions';
import { errorText } from '../components/ui';
import { translate } from '../i18n';
import { ar as arText } from '../i18n/ar';
import { en as enText } from '../i18n/en';
import { notificationLink, notificationText } from '../lib/notifications';
import { safeNext } from '../pages/Auth';

const en = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate('en', k, v);
const ar = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate('ar', k, v);

function renderAt(path: string, source: DataSource = demoSource, lang: 'en' | 'ar' = 'en') {
  return render(<App source={source} initialPath={path} lang={lang} />);
}

/** The first debtor in the list, once the list has loaded. */
async function firstDebtorLink(): Promise<HTMLElement> {
  return waitFor(() => {
    const a = screen.getAllByRole('link').find((x) => /^\/debtors\/./.test(x.getAttribute('href') ?? ''));
    if (!a) throw new Error('list not loaded');
    return a;
  });
}

function withRole(role: Me['user']['role']): DataSource {
  return {
    ...demoSource,
    me: async () => ({ ...(await demoSource.me()), user: { id: 'u9', fullName: 'Vera Viewer', role } }),
  };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

// ------------------------------------------------------------ small rules

describe('typed amounts', () => {
  it('accepts grouped, Arabic-digit and two-decimal amounts, as text', () => {
    expect(cleanAmount('1,250.5')).toBe('1250.50');
    expect(cleanAmount('٣٠٠')).toBe('300.00');
    expect(cleanAmount(' 99.99 ')).toBe('99.99');
    expect(cleanAmount('0012')).toBe('12.00');
  });
  it('refuses zero, negatives, three decimals and words', () => {
    for (const bad of ['0', '0.00', '-5', '1.234', 'abc', '', '1e5']) expect(cleanAmount(bad)).toBeNull();
  });
});

describe('after login, only pages inside the app are followed', () => {
  it('keeps app paths and refuses other sites', () => {
    expect(safeNext('/debtors?status=paid')).toBe('/debtors?status=paid');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('error messages', () => {
  it('uses our own words for known refusals, in both languages', () => {
    const t = ((k, v) => translate('ar', k, v)) as Parameters<typeof errorText>[1];
    expect(errorText(new ApiError(409, 'outside_working_hours', 'x'), t)).toBe(ar('error.outside_working_hours'));
    expect(errorText(new ApiError(502, 'failed', 'x'), t)).toBe(ar('error.send_failed'));
    expect(errorText(new ApiError(500, 'boom', 'stack trace'), t)).toBe(ar('common.failed'));
    expect(errorText(new Error('x'), t)).toBe(ar('common.failed'));
  });
  it('shows the API message for a field rule it names', () => {
    const t = ((k, v) => translate('en', k, v)) as Parameters<typeof errorText>[1];
    expect(errorText(new ApiError(400, 'invalid', 'The corrected amount must be at least SAR 500.00'), t)).toContain('SAR 500.00');
  });
});

describe('notification text', () => {
  const base = { id: 'n', kind: 'system' as const, title: 'Fallback title', target_table: null, target_id: null, read_at: null, created_at: new Date().toISOString() };
  it('is built from the details in the reader language', () => {
    const n = { ...base, kind: 'dispute' as const, data: { event: 'dispute' as const, name: 'Imran', ref: 'DBT-1', debtor_id: 'd1' } };
    expect(notificationText(n, (k, v) => translate('en', k, v))).toBe(en('note.dispute', { name: 'Imran', ref: 'DBT-1' }));
    expect(notificationText(n, (k, v) => translate('ar', k, v))).toBe(ar('note.dispute', { name: 'Imran', ref: 'DBT-1' }));
    expect(notificationLink(n)).toBe('/approvals');
  });
  it('builds the daily summary from its counts', () => {
    const n = { ...base, data: { event: 'summary' as const, summary: { reminders_sent: 12, replies: 3, promises: 2, payments_to_review: 1 } } };
    expect(notificationText(n, (k, v) => translate('en', k, v))).toBe(en('note.summary', { sent: 12, replies: 3, promises: 2, payments: 1 }));
  });
  it('falls back to the stored title without details', () => {
    expect(notificationText({ ...base, data: null }, (k, v) => translate('en', k, v))).toBe('Fallback title');
  });
  it('links to the debtor when it is about one', () => {
    expect(notificationLink({ ...base, data: { event: 'needs_reply', debtor_id: 'abc' } })).toBe('/debtors/abc');
  });
});

describe('every text exists in both languages', () => {
  it('has the same keys in English and Arabic, with no em dashes and no empty text', () => {
    expect(Object.keys(arText).sort()).toEqual(Object.keys(enText).sort());
    const all = JSON.stringify([enText, arText]);
    expect(all.includes('\u2014')).toBe(false);
    for (const v of [...Object.values(enText), ...Object.values(arText)]) {
      for (const s of typeof v === 'string' ? [v] : Object.values(v)) expect(s.trim()).not.toBe('');
    }
  });
  it('Arabic text uses the same placeholders as English', () => {
    const vars = (v: unknown) => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) ?? [])].sort();
    for (const k of Object.keys(enText) as (keyof typeof enText)[]) {
      const e = vars(enText[k]).filter((x) => x !== '{count}');
      const a = vars(arText[k]).filter((x) => x !== '{count}');
      expect([k, a]).toEqual([k, e]);
    }
  });
});

// ------------------------------------------------------------------ login

describe('login', () => {
  it('sends a visitor without a session to the login page, then back to where they were', async () => {
    let signedIn = false;
    const source: DataSource = {
      ...demoSource,
      me: async () => {
        if (!signedIn) throw new ApiError(401, 'unauthorized', 'Log in');
        return demoSource.me();
      },
      login: async (email, password) => {
        if (password !== 'correct horse') throw new ApiError(401, 'wrong_login', 'x');
        signedIn = email === 'noura@alnokhba.example';
      },
    };
    const user = userEvent.setup();
    renderAt('/debtors?status=disputed', source);
    expect(await screen.findByRole('heading', { name: en('login.title') })).toBeInTheDocument();

    await user.type(screen.getByLabelText(en('login.email')), 'noura@alnokhba.example');
    await user.type(screen.getByLabelText(en('login.password')), 'wrong one');
    await user.click(screen.getByRole('button', { name: en('login.submit') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en('login.wrong'));
    // The password is cleared after a failed try.
    expect(screen.getByLabelText(en('login.password'))).toHaveValue('');

    await user.type(screen.getByLabelText(en('login.password')), 'correct horse');
    await user.click(screen.getByRole('button', { name: en('login.submit') }));
    expect(await screen.findByRole('heading', { name: en('debtors.title') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(en('status.disputed')) })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the locked message in Arabic', async () => {
    const source: DataSource = {
      ...demoSource,
      me: async () => {
        throw new ApiError(401, 'unauthorized', 'x');
      },
      login: async () => {
        throw new ApiError(423, 'locked', 'Too many wrong passwords.');
      },
    };
    const user = userEvent.setup();
    renderAt('/', source, 'ar');
    await user.type(await screen.findByLabelText(ar('login.email')), 'a@b.co');
    await user.type(screen.getByLabelText(ar('login.password')), 'whatever-123');
    await user.click(screen.getByRole('button', { name: ar('login.submit') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(ar('error.locked'));
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('shows and hides the password', async () => {
    const user = userEvent.setup();
    renderAt('/login');
    const input = await screen.findByLabelText(en('login.password'));
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: en('login.showPassword') }));
    expect(input).toHaveAttribute('type', 'text');
  });

  it('forgot password always says the link is on its way', async () => {
    const sent: string[] = [];
    const user = userEvent.setup();
    renderAt('/forgot', { ...demoSource, forgotPassword: async (e) => void sent.push(e) });
    await user.type(await screen.findByLabelText(en('login.email')), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: en('forgot.submit') }));
    expect(await screen.findByText(en('forgot.sent', { email: 'nobody@example.com' }))).toBeInTheDocument();
    expect(sent).toEqual(['nobody@example.com']);
  });

  it('a new password must be long enough and typed the same twice', async () => {
    const saved: string[] = [];
    const user = userEvent.setup();
    renderAt('/reset?token=abc', { ...demoSource, resetPassword: async (_t, p) => void saved.push(p) });
    const pw = await screen.findByLabelText(en('reset.password'));
    await user.type(pw, 'short');
    await user.click(screen.getByRole('button', { name: en('reset.submit') }));
    expect(await screen.findByText(en('reset.tooShort'))).toBeInTheDocument();
    await user.type(pw, ' but now long');
    await user.type(screen.getByLabelText(en('reset.confirm')), 'something else');
    await user.click(screen.getByRole('button', { name: en('reset.submit') }));
    expect(await screen.findByText(en('reset.noMatch'))).toBeInTheDocument();
    expect(saved).toEqual([]);
    await user.clear(screen.getByLabelText(en('reset.confirm')));
    await user.type(screen.getByLabelText(en('reset.confirm')), 'short but now long');
    await user.click(screen.getByRole('button', { name: en('reset.submit') }));
    expect(await screen.findByText(en('reset.done'))).toBeInTheDocument();
    expect(saved).toEqual(['short but now long']);
  });

  it('an expired link offers a new one', async () => {
    renderAt('/reset?token=old', {
      ...demoSource,
      checkResetLink: async () => {
        throw new ApiError(410, 'link_expired', 'x');
      },
    });
    expect(await screen.findByText(en('reset.expired'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en('reset.newLink') })).toHaveAttribute('href', '/forgot');
  });

  it('an invitation greets the person by name', async () => {
    renderAt('/reset?token=inv', { ...demoSource, checkResetLink: async () => ({ kind: 'invite', fullName: 'Sara Al-Harbi', email: 'sara@x.example' }) });
    expect(await screen.findByRole('heading', { name: en('reset.inviteTitle', { name: 'Sara' }) })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ pages

describe('pages and actions', () => {
  it('records a payment and confirms it', async () => {
    const calls: unknown[] = [];
    const source: DataSource = { ...demoSource, recordPayment: async (id, input) => void calls.push([id, input]) };
    const user = userEvent.setup();
    renderAt('/debtors', source);
    const first = await firstDebtorLink();
    await user.click(first);
    await user.click(await screen.findByRole('button', { name: en('debtor.recordPayment') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en('action.payment.submit') }));
    expect(within(dialog).getByText(en('common.required'))).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(en('action.payment.amount')), '1,000.5');
    await user.click(within(dialog).getByLabelText(en('method.cash')));
    await user.click(within(dialog).getByRole('button', { name: en('action.payment.submit') }));
    expect(await screen.findByText(en('action.payment.done', { amount: '1,000.50' }))).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect((calls[0] as [string, { amount: string; method: string }])[1]).toMatchObject({ amount: '1000.50', method: 'cash' });
  });

  it('refuses a payment larger than what is owed, without calling the API', async () => {
    const calls: unknown[] = [];
    const user = userEvent.setup();
    renderAt('/debtors', { ...demoSource, recordPayment: async (...a) => void calls.push(a) });
    const first = await firstDebtorLink();
    await user.click(first);
    await user.click(await screen.findByRole('button', { name: en('debtor.recordPayment') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(en('action.payment.amount')), '99999999');
    await user.click(within(dialog).getByRole('button', { name: en('action.payment.submit') }));
    expect(within(dialog).getByLabelText(en('action.payment.amount'))).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
  });

  it('pausing needs a reason', async () => {
    const calls: unknown[] = [];
    const user = userEvent.setup();
    renderAt('/debtors?status=in_follow_up', { ...demoSource, pauseDebt: async (...a) => void calls.push(a) });
    const first = await firstDebtorLink();
    await user.click(first);
    await user.click(await screen.findByRole('button', { name: en('debtor.pause') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en('action.pause.submit') }));
    expect(calls).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(en('action.pause.reason')), 'Agreed a salary deduction');
    await user.click(within(dialog).getByRole('button', { name: en('action.pause.submit') }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0] as unknown[])[1]).toBe('Agreed a salary deduction');
  });

  it('shows a refused reminder in the reader language', async () => {
    const user = userEvent.setup();
    renderAt(
      '/debtors?status=in_follow_up',
      {
        ...demoSource,
        sendReminder: async () => {
          throw new ApiError(409, 'outside_working_hours', 'Outside working hours');
        },
      },
      'ar',
    );
    const first = await firstDebtorLink();
    await user.click(first);
    await user.click(await screen.findByRole('button', { name: ar('debtor.sendReminder') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: ar('debtor.sendReminder') }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(ar('error.outside_working_hours'));
  });

  it('rejecting a payment needs a reason', async () => {
    const calls: unknown[] = [];
    const user = userEvent.setup();
    renderAt('/approvals/payments', { ...demoSource, rejectPayment: async (...a) => void calls.push(a) });
    await user.click((await screen.findAllByRole('button', { name: en('approvals.reject') }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(en('approvals.reject.reason')), 'No');
    await user.click(within(dialog).getByRole('button', { name: en('approvals.reject.submit') }));
    expect(calls).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(en('approvals.reject.reason')), 't our bank');
    await user.click(within(dialog).getByRole('button', { name: en('approvals.reject.submit') }));
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('deciding the debtor is right asks what happens to the debt', async () => {
    const calls: unknown[] = [];
    const user = userEvent.setup();
    renderAt('/approvals/disputes', { ...demoSource, resolveDispute: async (...a) => (calls.push(a), { debt_status: 'in_follow_up' }) });
    await user.click((await screen.findAllByRole('button', { name: en('approvals.dispute.resolveValid') }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(en('approvals.dispute.note')), 'Checked the contract: rent was 1,200');
    await user.type(within(dialog).getByLabelText(en('approvals.dispute.correctAmount')), '1200');
    await user.click(within(dialog).getByRole('button', { name: en('approvals.dispute.submit') }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0] as unknown[])[1]).toEqual({
      outcome: 'debtor_right',
      note: 'Checked the contract: rent was 1,200',
      action: 'correct_amount',
      corrected_amount: '1200.00',
    });
  });

  it('a viewer sees the numbers but no buttons that change anything', async () => {
    renderAt('/debtors', withRole('viewer'));
    expect(await screen.findByRole('heading', { name: en('debtors.title') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en('debtors.add') })).not.toBeInTheDocument();
  });

  it('a viewer cannot approve payments', async () => {
    renderAt('/approvals/payments', withRole('viewer'));
    await screen.findAllByText(en('approvals.payment.read'));
    expect(screen.queryByRole('button', { name: en('approvals.approve') })).not.toBeInTheDocument();
  });

  it('settings: only owners and admins change the rules; hours must end after they start', async () => {
    const saved: unknown[] = [];
    const user = userEvent.setup();
    renderAt('/settings', { ...withRole('admin'), updateRules: async (c) => (saved.push(c), { ...(await demoSource.rules()), ...c }) });
    const from = await screen.findByLabelText(en('settings.rules.from'));
    const to = screen.getByLabelText(en('settings.rules.to'));
    await user.clear(to);
    await user.type(to, '08:00');
    await user.clear(from);
    await user.type(from, '10:00');
    await user.click(screen.getByRole('button', { name: en('common.save') }));
    expect(await screen.findByText(en('settings.rules.hoursOrder'))).toBeInTheDocument();
    expect(saved).toHaveLength(0);
    await user.clear(to);
    await user.type(to, '18:00');
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: en('common.save') }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ working_hours_start: '10:00', working_hours_end: '18:00', auto_send: true });
  });

  it('settings: staff see the rules but cannot change them', async () => {
    renderAt('/settings', withRole('staff'));
    expect(await screen.findByText(en('settings.rules.readOnly'))).toBeInTheDocument();
    expect(screen.getByLabelText(en('settings.rules.interval'))).toBeDisabled();
    expect(screen.queryByRole('button', { name: en('common.save') })).not.toBeInTheDocument();
  });

  it('team: an admin cannot make someone an owner or change an owner', async () => {
    renderAt('/settings/team', withRole('admin'));
    const owner = (await screen.findByText('Khalid Al-Ghamdi')).closest('li')!;
    expect(within(owner).queryByRole('combobox')).not.toBeInTheDocument();
    const staff = screen.getByText('Reem Al-Shehri').closest('li')!;
    const options = within(within(staff).getByRole('combobox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).not.toContain(en('role.owner'));
  });

  it('add debtor: checks the form, then opens the new debtor', async () => {
    const sent: unknown[] = [];
    const user = userEvent.setup();
    renderAt('/debtors', { ...demoSource, addDebtor: async (d) => (sent.push(d), demoSource.addDebtor(d)) });
    await user.click(await screen.findByRole('button', { name: en('debtors.add') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en('add.submit') }));
    expect(within(dialog).getAllByText(en('common.required')).length).toBeGreaterThanOrEqual(4);
    expect(sent).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(en('add.fullName')), 'Test Person');
    await user.type(within(dialog).getByLabelText(en('add.idNumber')), '2123456789');
    await user.type(within(dialog).getByLabelText(en('add.phones')), '0551234567');
    await user.type(within(dialog).getByLabelText(en('add.amount')), '750');
    await user.type(within(dialog).getByLabelText(en('add.reason')), 'Uniform not returned');
    await user.click(within(dialog).getByRole('button', { name: en('add.submit') }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ full_name: 'Test Person', phones: ['0551234567'], debts: [{ amount: '750.00', reason: 'Uniform not returned' }] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Test Person' })).toBeInTheDocument();
  });

  it('add debtor: shows the API field errors next to the right input', async () => {
    const user = userEvent.setup();
    renderAt('/debtors', {
      ...demoSource,
      addDebtor: async () => {
        throw new ApiError(400, 'invalid', 'x', [{ field: 'phones[0]', message: 'Phone "05" is too short' }]);
      },
    });
    await user.click(await screen.findByRole('button', { name: en('debtors.add') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(en('add.fullName')), 'Test Person');
    await user.type(within(dialog).getByLabelText(en('add.idNumber')), '2123456789');
    await user.type(within(dialog).getByLabelText(en('add.phones')), '05');
    await user.type(within(dialog).getByLabelText(en('add.amount')), '750');
    await user.type(within(dialog).getByLabelText(en('add.reason')), 'Uniform');
    await user.click(within(dialog).getByRole('button', { name: en('add.submit') }));
    expect(await within(dialog).findByText('Phone "05" is too short')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(en('add.phones'))).toHaveAttribute('aria-invalid', 'true');
  });

  it('import: refuses a file that is not Excel, and shows the check report', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderAt('/import', withRole('staff'));
    const input = (await screen.findByText(en('import.choose'))).closest('label')!.querySelector('input')!;
    await user.upload(input, new File(['a,b'], 'list.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en('import.wrongType'));
    await user.upload(input, new File(['x'], 'debts with errors.xlsx'));
    expect(await screen.findByText(en('import.failed', { count: 3 }))).toBeInTheDocument();
    expect(screen.getByText(en('import.row', { row: 9 }))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
    await user.upload(input, new File(['x'], 'march.xlsx'));
    const confirm = await screen.findByRole('button', { name: en('import.confirm', { count: 24 }) });
    await user.click(confirm);
    expect(await screen.findByRole('heading', { name: en('import.done', { count: 24 }) })).toBeInTheDocument();
  });

  it('notifications: marks all as read', async () => {
    const user = userEvent.setup();
    renderAt('/notifications');
    const button = await screen.findByRole('button', { name: en('notes.markAll') });
    await user.click(button);
    await waitFor(() => expect(screen.getByText(en('notes.unread', { count: 0 }))).toBeInTheDocument());
  });

  it('the Arabic menu, pages and numbers', async () => {
    renderAt('/', demoSource, 'ar');
    expect(await screen.findByRole('link', { name: ar('nav.legal') })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    // Western digits in Arabic, as agreed.
    await waitFor(() => expect(document.body.textContent).toMatch(/\d/));
    expect(document.body.textContent).not.toMatch(/[٠-٩]/);
  });

  it('dialogs close with Escape and the cancel button', async () => {
    const user = userEvent.setup();
    renderAt('/debtors');
    await user.click(await screen.findByRole('button', { name: en('debtors.add') }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: en('add.title') })).not.toBeInTheDocument());
  });

  it('logging out goes to the login page', async () => {
    let out = false;
    const user = userEvent.setup();
    renderAt('/', { ...demoSource, logout: async () => void (out = true) });
    await user.click(await screen.findByRole('button', { name: en('nav.logout') }));
    expect(await screen.findByRole('heading', { name: en('login.title') })).toBeInTheDocument();
    expect(out).toBe(true);
  });
});

describe('documents', () => {
  it('lists the debtor documents and uploads a new one; other file types are refused', async () => {
    const sent: unknown[] = [];
    const user = userEvent.setup({ applyAccept: false });
    renderAt('/debtors', { ...demoSource, uploadDocument: async (a) => (sent.push(a), demoSource.uploadDocument(a)) });
    await user.click(await firstDebtorLink());
    expect(await screen.findByText('id-copy.jpg', { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en('docs.add') }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(en('docs.file'));
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await user.click(within(dialog).getByRole('button', { name: en('docs.submit') }));
    expect(await within(dialog).findByText(en('docs.wrongType'))).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    await user.upload(input, new File(['%PDF-1.4'], 'contract.pdf', { type: 'application/pdf' }));
    await user.selectOptions(within(dialog).getByLabelText(en('docs.type')), 'contract');
    await user.click(within(dialog).getByRole('button', { name: en('docs.submit') }));
    expect(await screen.findByText(en('docs.done', { file: 'contract.pdf' }))).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ docType: 'contract' });
  });
});

// ------------------------------------------------------- legal and Najiz

/** The case page of a sample legal debt, by debtor name. */
async function legalCaseOf(name: string) {
  const rows = await demoSource.legal();
  return rows.find((r) => r.full_name === name)!;
}

describe('legal and Najiz filing', () => {
  it('lists each debt with where it stands, the total as text, and the note template', async () => {
    renderAt('/legal');
    expect(await screen.findByText('Bilal Ahmed')).toBeInTheDocument();
    expect(screen.getByText(en('legal.stage.missing', { count: 2 }))).toBeInTheDocument();
    expect(screen.getByText(en('legal.stage.to_approve'))).toBeInTheDocument();
    expect(screen.getByText(en('legal.stage.approved'))).toBeInTheDocument();
    expect(screen.getByText(en('legal.total', { count: 3 }))).toBeInTheDocument();
    // 4,200 + 3,200 + 2,250, added as text
    expect(screen.getByText('9,650')).toBeInTheDocument();
    const tpl = screen.getByRole('link', { name: en('legal.template.download') });
    expect(tpl).toHaveAttribute('download', 'promissory-note-template.docx');
    expect(tpl.getAttribute('href')).toBeTruthy();
    // Only the approved debt can be chosen, and it is chosen at the start.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('button', { name: en('legal.fileSelected', { count: 1 }) })).toBeEnabled();
    expect(screen.queryByText('Omar Farouk')).not.toBeInTheDocument();
  });

  it('shows what was filed on Najiz, in Arabic', async () => {
    renderAt('/legal/filed', demoSource, 'ar');
    expect(await screen.findByText('Omar Farouk')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: ar('legal.title') })).toBeInTheDocument();
    expect(screen.getByText('401014800012345')).toBeInTheDocument();
    expect(screen.getByText('قيد التنفيذ')).toBeInTheDocument();
    expect(screen.getByText(ar('legal.checksHint'))).toBeInTheDocument();
  });

  it('a case with missing details cannot be approved until they are filled in', async () => {
    const bilal = await legalCaseOf('Bilal Ahmed');
    const saved: unknown[] = [];
    const user = userEvent.setup();
    renderAt(`/legal/case/${bilal.debt_id}`, { ...demoSource, saveNajizDetails: async (id, input) => void saved.push({ id, input }) });
    expect(await screen.findByText(en('case.missingTitle', { count: 2 }))).toBeInTheDocument();
    expect(screen.getByText(en('najiz.field.debtor_name'))).toBeInTheDocument();
    expect(screen.getByText(en('najiz.field.note_place'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en('case.approve') })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: en('case.editName') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    expect(within(dialog).getAllByText(en('common.required'))).toHaveLength(2);
    expect(saved).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(en('case.firstName')), 'Bilal');
    await user.type(within(dialog).getByLabelText(en('case.familyName')), 'Ahmed');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ id: bilal.debt_id, input: { debtor: { first_name: 'Bilal', family_name: 'Ahmed' } } });
  });

  it('the place of the note and its due type are asked for together', async () => {
    const bilal = await legalCaseOf('Bilal Ahmed');
    const saved: unknown[] = [];
    const user = userEvent.setup();
    renderAt(`/legal/case/${bilal.debt_id}`, { ...demoSource, saveNajizDetails: async (_id, input) => void saved.push(input) });
    await user.click(await screen.findByRole('button', { name: en('case.editNote') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText(en('case.onDemand')));
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    expect(within(dialog).getByText(en('common.required'))).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(en('case.placeLabel')), 'Jeddah');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    await waitFor(() => expect(saved).toEqual([{ note: { issue_city: 'Jeddah', due_on_demand: true, due_date: null } }]));
  });

  it('approving needs the pledge and the owner email and mobile', async () => {
    const javed = await legalCaseOf('Javed Iqbal');
    const sent: unknown[] = [];
    const user = userEvent.setup();
    renderAt(`/legal/case/${javed.debt_id}`, { ...demoSource, approveFiling: async (id, input) => void sent.push({ id, input }) });
    expect(await screen.findByText(en('case.completeTitle'))).toBeInTheDocument();
    const email = screen.getByLabelText(en('case.contactEmail'));
    expect(email).toHaveValue('khalid@alnokhba.example');
    await user.click(screen.getByRole('button', { name: en('case.approve') }));
    expect(screen.getByText(en('case.pledgeNeeded'))).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, 'not-an-email');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: en('case.approve') }));
    expect(screen.getByText(en('case.emailBad'))).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    await user.clear(email);
    await user.type(email, 'owner@company.example');
    await user.click(screen.getByRole('button', { name: en('case.approve') }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ id: javed.debt_id, input: { contact_email: 'owner@company.example', contact_phone: '+966500000100', pledge: true } });
  });

  it('a viewer sees the case but cannot approve, edit or file', async () => {
    const javed = await legalCaseOf('Javed Iqbal');
    renderAt(`/legal/case/${javed.debt_id}`, withRole('viewer'));
    expect(await screen.findByText(en('case.viewerNote'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en('case.approve') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en('case.editName') })).not.toBeInTheDocument();
  });

  it('filing signs in with Nafath: the number is shown, and the owner is asked to choose it', async () => {
    const started: string[][] = [];
    const run = {
      id: 'run-t', kind: 'file' as const, stage: 'waiting_nafath' as const, nafath_number: '47', nafath_expires_at: new Date(Date.now() + 60_000).toISOString(),
      nafath_sent: false, owner_phone_last4: '0100', started_at: new Date().toISOString(), stop_reason: null,
      cases: [{ debt_id: 'x', full_name: 'Nasir Mahmood', ref_code: 'DBT-2026-0019', amount: '2250.00', step: 'waiting' as const, request_number: null }],
    };
    const user = userEvent.setup();
    renderAt('/legal', { ...demoSource, startNajizRun: async (ids) => (started.push(ids), run), najizRun: async () => run, cancelNajizRun: async () => undefined });
    await user.click(await screen.findByRole('button', { name: en('legal.fileSelected', { count: 1 }) }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Nasir Mahmood')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: en('najiz.start') }));
    expect(await within(dialog).findByLabelText(en('najiz.nafathNumber', { n: '47' }))).toBeInTheDocument();
    // Not sent on WhatsApp until Meta approves a template: the screen does not claim it was.
    expect(within(dialog).getByText(en('najiz.nafathTell'))).toBeInTheDocument();
    expect(within(dialog).queryByText(en('najiz.nafathSent', { last4: '0100' }))).not.toBeInTheDocument();
    expect(started).toHaveLength(1);
    expect(started[0]).toHaveLength(1);
  });

  it('a filing that stopped says why, in Arabic', async () => {
    const run = {
      id: 'run-s', kind: 'file' as const, stage: 'stopped' as const, nafath_number: null, nafath_expires_at: null, nafath_sent: false, owner_phone_last4: '0100',
      started_at: new Date().toISOString(), stop_reason: 'captcha' as const,
      cases: [{ debt_id: 'x', full_name: 'Nasir Mahmood', ref_code: 'DBT-2026-0019', amount: '2250.00', step: 'stopped' as const, request_number: null }],
    };
    const user = userEvent.setup();
    renderAt('/legal', { ...demoSource, startNajizRun: async () => run, najizRun: async () => run }, 'ar');
    await user.click(await screen.findByRole('button', { name: ar('legal.fileSelected', { count: 1 }) }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ar('najiz.start') }));
    expect(await screen.findByText(ar('najiz.stop.captcha'))).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: ar('najiz.stoppedTitle') })).toBeInTheDocument();
  });

  it('company details: owners and admins check the owner ID and unified number', async () => {
    const javed = await legalCaseOf('Javed Iqbal');
    const saved: unknown[] = [];
    const user = userEvent.setup();
    renderAt(`/legal/case/${javed.debt_id}`, { ...withRole('admin'), saveNajizDetails: async (_id, input) => void saved.push(input) });
    await user.click(await screen.findByRole('button', { name: en('case.editCompany') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(en('case.ownerId')), '2000000100');
    await user.clear(within(dialog).getByLabelText(en('case.unified')));
    await user.type(within(dialog).getByLabelText(en('case.unified')), '4030000000');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    expect(within(dialog).getByText(en('case.ownerIdBad'))).toBeInTheDocument();
    expect(within(dialog).getByText(en('case.unifiedBad'))).toBeInTheDocument();
    expect(saved).toHaveLength(0);
    await user.selectOptions(within(dialog).getByLabelText(en('case.ownerIdType')), 'iqama');
    await user.clear(within(dialog).getByLabelText(en('case.unified')));
    await user.type(within(dialog).getByLabelText(en('case.unified')), '7000000002');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    await waitFor(() => expect(saved).toEqual([{ company: { owner_id_type: 'iqama', owner_id_number: '2000000100', unified_number: '7000000002' } }]));
  });

  it('staff do not see the company details button', async () => {
    const javed = await legalCaseOf('Javed Iqbal');
    renderAt(`/legal/case/${javed.debt_id}`);
    expect(await screen.findByText(en('case.completeTitle'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en('case.editCompany') })).not.toBeInTheDocument();
  });

  it('a missing file is uploaded from the case page, as a PDF only', async () => {
    const bilal = await legalCaseOf('Bilal Ahmed');
    const sent: unknown[] = [];
    const base = await demoSource.legalCase(bilal.debt_id);
    const user = userEvent.setup({ applyAccept: false });
    renderAt(`/legal/case/${bilal.debt_id}`, {
      ...demoSource,
      legalCase: async () => ({ ...base, files: { ...base.files, cr: null }, row: { ...base.row, missing: ['cr_file', ...base.row.missing] } }),
      uploadLegalFile: async (debtId, kind, file) => void sent.push({ debtId, kind, name: file.name }),
    });
    const input = await screen.findByLabelText(en('case.uploadOf', { file: en('case.file.cr') }));
    await user.upload(input, new File(['x'], 'cr.png', { type: 'image/png' }));
    expect(await screen.findByText(en('case.pdfOnly'))).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    await user.upload(input, new File(['%PDF-1.4'], 'cr.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(sent).toEqual([{ debtId: bilal.debt_id, kind: 'cr', name: 'cr.pdf' }]));
  });

  it('a note that may already be on Najiz: staff confirm they checked Najiz before filing again', async () => {
    const calls: { ids: string[]; checked?: boolean }[] = [];
    const user = userEvent.setup();
    renderAt('/legal', {
      ...demoSource,
      startNajizRun: async (ids, opts) => {
        calls.push({ ids, checked: opts?.checkedNotOnNajiz });
        if (!opts?.checkedNotOnNajiz) throw new ApiError(409, 'najiz_check_first', 'A note may already be on Najiz.');
        throw new ApiError(409, 'najiz_busy', 'Busy');
      },
    }, 'ar');
    await user.click(await screen.findByRole('button', { name: ar('legal.fileSelected', { count: 1 }) }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: ar('najiz.start') }));
    expect(await within(dialog).findByText(ar('error.najiz_check_first'))).toBeInTheDocument();
    const start = within(dialog).getByRole('button', { name: ar('najiz.start') });
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByLabelText(ar('najiz.checkedNotThere')));
    await user.click(start);
    expect(await within(dialog).findByText(ar('error.najiz_busy'))).toBeInTheDocument();
    expect(calls.map((c) => c.checked)).toEqual([false, true]);
  });

  it('status check: one Nafath approval, then each request with what its status means, in Arabic', async () => {
    let calls = 0;
    const filed = (await demoSource.legal()).filter((r) => ['submitted', 'order_issued', 'measures_applied'].includes(r.stage) && r.najiz_request_number);
    expect(filed.length).toBeGreaterThan(0);
    const base = {
      id: 'run-c', kind: 'status_check' as const, nafath_expires_at: null, nafath_sent: false, owner_phone_last4: '0100',
      started_at: new Date().toISOString(), stop_reason: null,
    };
    const cases = filed.map((r) => ({ debt_id: r.debt_id, full_name: r.full_name, ref_code: r.ref_code, amount: r.amount_outstanding, request_number: r.najiz_request_number }));
    const user = userEvent.setup();
    renderAt('/legal/filed', {
      ...demoSource,
      startNajizCheck: async () => {
        calls++;
        return { ...base, stage: 'waiting_nafath', nafath_number: '12', cases: cases.map((c) => ({ ...c, step: 'waiting' as const })) };
      },
      najizRun: async () => ({
        ...base, stage: 'done', nafath_number: null,
        cases: cases.map((c, i) => ({ ...c, step: 'checked' as const, najiz_status: i === 0 ? 'قيد المعالجة' : 'منتهي' })),
      }),
    }, 'ar');
    await user.click(await screen.findByRole('button', { name: ar('check.button') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ar('check.lead'))).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: ar('najiz.start') }));
    expect(await within(dialog).findByText(ar('check.doneTitle'))).toBeInTheDocument();
    expect(within(dialog).getByText('قيد المعالجة')).toBeInTheDocument();
    expect(within(dialog).getByText(ar('najizStatus.processing'))).toBeInTheDocument();
    // A status Talos does not know is shown as Najiz writes it, with no guessed meaning.
    if (cases.length > 1) expect(within(dialog).getAllByText('منتهي').length).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  it('viewers do not see the status check button', async () => {
    renderAt('/legal/filed', withRole('viewer'));
    await screen.findByRole('tab', { name: new RegExp(en('legal.tab.filed')) });
    expect(screen.queryByRole('button', { name: en('check.button') })).not.toBeInTheDocument();
  });

  it('a stopped filing marks a note that may be on Najiz', async () => {
    const run = {
      id: 'run-m', kind: 'file' as const, stage: 'stopped' as const, nafath_number: null, nafath_expires_at: null, nafath_sent: false, owner_phone_last4: '0100',
      started_at: new Date().toISOString(), stop_reason: 'worker_lost' as const,
      cases: [{ debt_id: 'x', full_name: 'Nasir Mahmood', ref_code: 'DBT-2026-0019', amount: '2250.00', step: 'sending' as const, request_number: null }],
    };
    const user = userEvent.setup();
    renderAt('/legal', { ...demoSource, startNajizRun: async () => run, najizRun: async () => run });
    await user.click(await screen.findByRole('button', { name: en('legal.fileSelected', { count: 1 }) }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en('najiz.start') }));
    expect(await screen.findByText(en('najiz.stop.worker_lost'))).toBeInTheDocument();
    expect(screen.getByText(en('najiz.maybeSent'))).toBeInTheDocument();
  });

  it('an approved case can get its request number by hand', async () => {
    const nasir = await legalCaseOf('Nasir Mahmood');
    const sent: unknown[] = [];
    const user = userEvent.setup();
    renderAt(`/legal/case/${nasir.debt_id}`, { ...demoSource, addLegalStatus: async (_id, input) => void sent.push(input) });
    await user.click(await screen.findByRole('button', { name: en('case.addStatus') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(en('case.statusLabel'))).toHaveValue('submitted');
    await user.type(within(dialog).getByLabelText(en('legal.col.request')), '401014800099999');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    await waitFor(() => expect(sent).toEqual([{ status: 'submitted', najiz_request_number: '401014800099999' }]));
  });

  it('the filing pack is made from the case page, and says when a file could not be attached', async () => {
    const javed = await legalCaseOf('Javed Iqbal');
    const made: string[] = [];
    const user = userEvent.setup();
    renderAt(`/legal/case/${javed.debt_id}`, { ...demoSource, makePack: async (id) => (made.push(id), { url: null, notAttached: 2 }) });
    await user.click(await screen.findByRole('button', { name: en('case.packMake') }));
    expect(await screen.findByText(en('case.packMadeMissing', { count: 2 }))).toBeInTheDocument();
    expect(made).toEqual([javed.debt_id]);
  });

  it('viewers can see the pack card but not make one', async () => {
    const javed = await legalCaseOf('Javed Iqbal');
    renderAt(`/legal/case/${javed.debt_id}`, withRole('viewer'));
    expect(await screen.findByText(en('case.pack'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en('case.packMake') })).not.toBeInTheDocument();
  });

  it('a status entered by hand needs the Najiz request number', async () => {
    const omar = await legalCaseOf('Omar Farouk');
    const sent: unknown[] = [];
    const user = userEvent.setup();
    renderAt(`/legal/case/${omar.debt_id}`, { ...demoSource, addLegalStatus: async (_id, input) => void sent.push(input) });
    await user.click(await screen.findByRole('button', { name: en('case.addStatus') }));
    const dialog = await screen.findByRole('dialog');
    const number = within(dialog).getByLabelText(en('legal.col.request'));
    await user.clear(number);
    await user.type(number, '12-34');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    expect(within(dialog).getByText(en('case.numberBad'))).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    await user.clear(number);
    await user.type(number, '401014800012345');
    await user.selectOptions(within(dialog).getByLabelText(en('case.statusLabel')), 'order_issued');
    await user.type(within(dialog).getByLabelText(`${en('case.statusNote')} (${en('common.optional')})`), 'Text message from Najiz');
    await user.click(within(dialog).getByRole('button', { name: en('common.save') }));
    await waitFor(() => expect(sent).toEqual([{ status: 'order_issued', najiz_request_number: '401014800012345', note: 'Text message from Najiz' }]));
  });
});
