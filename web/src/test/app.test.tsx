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
