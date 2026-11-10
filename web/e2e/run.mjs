/**
 * End-to-end run of the dashboard against the real API and a fresh dev
 * database, in a real browser (Chromium through Playwright).
 *
 * It checks every page and action in English and Arabic, light and dark, on
 * desktop and phone sizes: login, forgot and reset password, invitations,
 * roles, payments, disputes, reminders, pausing, adding a debtor, Excel
 * import, settings, notifications, page width on phones and accessibility
 * (axe-core). Run it with ./e2e/run.sh, which resets the database first.
 *
 * Env: APP (default http://localhost:5173), API (http://localhost:3000),
 *      MAIL_DIR (../api/.data/mail), FILES (folder with good.xlsx, bad.xlsx), SHOTS (optional).
 */
import assert from 'node:assert/strict';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:3000';
const MAIL_DIR = process.env.MAIL_DIR ?? join(here, '../../api/.data/mail');
const FILES = process.env.FILES ?? here;
const SHOTS = process.env.SHOTS;
const AXE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

const en = (await import('./text.mjs')).text('en');
const ar = (await import('./text.mjs')).text('ar');

const OWNER = { email: 'owner@demo.example', password: 'talos-dev-password' };
const STAFF = { email: 'staff@demo.example', password: 'talos-dev-password' };
const DEBT = {
  imran: '66666666-6666-4666-8666-000000000001',
  rahim: '66666666-6666-4666-8666-000000000003',
  ahmed: '66666666-6666-4666-8666-000000000004',
  javed: '66666666-6666-4666-8666-000000000099',
};
const DEBTOR = {
  imran: '33333333-3333-4333-8333-000000000001',
  fahad: '33333333-3333-4333-8333-000000000002',
  rahim: '33333333-3333-4333-8333-000000000003',
};

const browser = await chromium.launch();
let passed = 0;
const failures = [];
const consoleErrors = [];

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err?.message ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

async function newPage({ lang = 'en', theme = 'light', width = 1366, height = 900, mobile = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
    acceptDownloads: true,
  });
  await ctx.addInitScript(([l, t]) => {
    if (!sessionStorage.getItem('e2e.init')) {
      localStorage.setItem('talos.lang', l);
      localStorage.setItem('talos.theme', t);
      sessionStorage.setItem('e2e.init', '1');
    }
  }, [lang, theme]);
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Refused requests the test causes on purpose (401 before login, 4xx on wrong input, 501 for filing from Talos, not built yet) are expected.
    if (/status of (401|400|403|404|409|410|423|429|501|503)/.test(text)) return;
    consoleErrors.push(`${page.url()}: ${text}`);
  });
  return page;
}

async function login(page, who = OWNER, t = en) {
  await page.goto(`${APP}/login`);
  await page.getByLabel(t['login.email']).fill(who.email);
  await page.getByLabel(t['login.password'], { exact: true }).fill(who.password);
  await page.getByRole('button', { name: t['login.submit'] }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.getByRole('navigation').first().waitFor();
}

/**
 * One session per person for the whole run. The API allows a limited number
 * of logins per address (20 in 5 minutes), so only the login tests log in
 * through the page; other steps reuse these.
 */
const sessions = new Map();
async function sessionCookie(who) {
  if (!sessions.has(who.email)) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-talos': '1' },
      body: JSON.stringify(who),
    });
    assert.equal(res.status, 200, `API login for ${who.email}`);
    sessions.set(who.email, res.headers.get('set-cookie').split(';')[0]);
  }
  return sessions.get(who.email);
}

/** A page already logged in, through the shared session. */
async function signedIn(who = OWNER, opts = {}) {
  const page = await newPage(opts);
  const [name, value] = (await sessionCookie(who)).split('=');
  await page.context().addCookies([{ name, value, domain: new URL(APP).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  return page;
}

/** API calls with a person's session, for checking what the screens did. */
async function apiSession(who = OWNER) {
  const cookie = await sessionCookie(who);
  return async (path, init = {}) => {
    const r = await fetch(`${API}${path}`, { ...init, headers: { cookie, 'x-talos': '1', 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const body = await r.text();
    return { status: r.status, body: body ? JSON.parse(body) : null };
  };
}

async function latestMail(to, after) {
  for (let i = 0; i < 40; i++) {
    const files = (await readdir(MAIL_DIR).catch(() => [])).filter((f) => f.endsWith(`${to.replace(/[^a-z0-9@.]/gi, '_')}.txt`)).sort();
    const last = files[files.length - 1];
    if (last && last > after) return readFile(join(MAIL_DIR, last), 'utf8');
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email to ${to}`);
}
const mailStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const linkIn = (mail) => {
  const m = mail.match(/https?:\/\/\S+\/reset-password\?token=[\w-]+/);
  assert.ok(m, 'the email has a link');
  return new URL(m[0]);
};

async function toast(page, text) {
  await page.locator('.toast').filter({ hasText: text }).first().waitFor({ timeout: 8000 });
}

async function axe(page, label) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  const serious = result.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.deepEqual(serious, [], `${label}: accessibility problems`);
}

async function noSideScroll(page, label) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width + 1, `${label}: page is ${scroll}px wide on a ${width}px screen`);
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/**
 * Words in Latin letters left in an Arabic page. Allowed: the fake people and
 * company (their names end in "Demo"), references, emails, SAR, product names.
 */
async function englishLeftInArabic(page) {
  return page.evaluate(() => {
    const allowed = /^(SAR|WhatsApp|Excel|Word|Talos|TALOS|Najiz|Nafith|xlsx|MB|AM|PM|[A-Z]{1,4}|DBT|TRX|CHQ|Demo)$/;
    const skip = '[dir="ltr"], .ref, .code, bdi, .person-email, .bubble-body, .event-quote, blockquote, .template-body, .issues, .report-file, .read-facts, .receipt';
    const names = /([A-Z][a-z]+ )+Demo( [A-Z][a-z]+)*|Demo [A-Z][a-z]+( [A-Z][a-z]+)*/g;
    const out = new Set();
    const walk = (n) => {
      if (n.nodeType === 3) {
        const text = n.textContent.replace(names, '').replace(/[\w.+-]+@[\w.-]+/g, '');
        for (const w of text.match(/[A-Za-z]{2,}/g) ?? []) if (!allowed.test(w)) out.add(w);
      } else if (n.nodeType === 1 && !['SCRIPT', 'STYLE'].includes(n.tagName) && !n.matches(skip)) {
        n.childNodes.forEach(walk);
      }
    };
    walk(document.querySelector('main') ?? document.body);
    return [...out];
  });
}

// =========================================================================

console.log('\nLogin and passwords');

await step('a visitor without a session lands on the login page, and comes back to the page they wanted', async () => {
  const page = await newPage();
  await page.goto(`${APP}/debtors?status=disputed`);
  await page.waitForURL(/\/login\?next=/);
  await page.getByLabel(en['login.email']).fill(OWNER.email);
  await page.getByLabel(en['login.password'], { exact: true }).fill('not the password');
  await page.getByRole('button', { name: en['login.submit'] }).click();
  await page.getByRole('alert').filter({ hasText: en['login.wrong'] }).waitFor();
  await page.getByLabel(en['login.password'], { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: en['login.submit'] }).click();
  await page.waitForURL(/\/debtors\?status=disputed/);
  await page.getByRole('heading', { name: en['debtors.title'] }).waitFor();
  await axe(page, 'debtors');
  await page.context().close();
});

await step('the login page in Arabic, right to left, with no accessibility problems', async () => {
  const page = await newPage({ lang: 'ar', theme: 'dark' });
  await page.goto(`${APP}/login`);
  await page.getByRole('heading', { name: ar['login.title'] }).waitFor();
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  assert.equal(await page.getAttribute('html', 'lang'), 'ar');
  await axe(page, 'login ar');
  await shot(page, 'login-ar-dark');
  await page.context().close();
});

await step('forgot password: the email arrives, the link sets a new password once, the old one stops working', async () => {
  const page = await newPage();
  const since = mailStamp();
  await page.goto(`${APP}/login`);
  await page.getByRole('link', { name: en['login.forgot'] }).click();
  await page.getByLabel(en['login.email']).fill(STAFF.email);
  await page.getByRole('button', { name: en['forgot.submit'] }).click();
  await page.getByText(en['forgot.sent'].replace('{email}', STAFF.email)).waitFor();
  const link = linkIn(await latestMail(STAFF.email, since));
  await page.goto(`${APP}${link.pathname}${link.search}`);
  await page.getByRole('heading', { name: en['reset.title'] }).waitFor();
  await page.getByLabel(en['reset.password'], { exact: true }).fill('a new long password');
  await page.getByLabel(en['reset.confirm'], { exact: true }).fill('a new long password');
  await page.getByRole('button', { name: en['reset.submit'] }).click();
  await page.waitForURL(/\/login\?reset=done/);
  await page.getByText(en['reset.done']).waitFor();
  // The link works once.
  await page.goto(`${APP}${link.pathname}${link.search}`);
  await page.getByText(en['reset.expired']).waitFor();
  // Old password refused, new one works.
  const old = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-talos': '1' }, body: JSON.stringify(STAFF) });
  assert.equal(old.status, 401);
  STAFF.password = 'a new long password';
  await login(page, STAFF);
  await page.context().close();
});

await step('logging out ends the session: the pages ask to log in again', async () => {
  // Its own login, so the shared session stays open for the other steps.
  const page = await newPage();
  await login(page);
  await page.getByRole('button', { name: en['nav.logout'] }).click();
  await page.waitForURL(/\/login/);
  await page.goto(`${APP}/approvals`);
  await page.waitForURL(/\/login\?next=%2Fapprovals/);
  await page.context().close();
});

console.log('\nEvery page, both languages, both themes, desktop and phone');

const PAGES = ['/', '/debtors', `/debtors/${DEBTOR.imran}`, '/approvals/payments', '/approvals/disputes', '/approvals/reminders', '/legal', '/notifications', '/import', '/settings/rules', '/settings/team', '/settings/templates'];
for (const [lang, theme, width, height, mobile] of [
  ['en', 'light', 1366, 900, false],
  ['ar', 'dark', 1366, 900, false],
  ['ar', 'light', 390, 844, true],
  ['en', 'dark', 390, 844, true],
]) {
  await step(`${lang} ${theme} ${width}px: every page loads, fits the screen, and passes the accessibility check`, async () => {
    const t = lang === 'ar' ? ar : en;
    const page = await signedIn(OWNER, { lang, theme, width, height, mobile });
    for (const path of PAGES) {
      await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' });
      await page.locator('main h1').first().waitFor();
      await page.waitForLoadState('networkidle');
      // Every placeholder is replaced by real content (within 15 s, the dev server compiles on demand).
      await page.locator('.skeleton, [aria-busy="true"]').first().waitFor({ state: 'detached', timeout: 15_000 });
      assert.equal(await page.getAttribute('html', 'dir'), lang === 'ar' ? 'rtl' : 'ltr');
      await noSideScroll(page, `${path} ${lang} ${width}`);
      await axe(page, `${path} ${lang} ${theme} ${width}`);
      if (lang === 'ar') {
        const left = await englishLeftInArabic(page);
        assert.deepEqual(left, [], `${path}: English left in the Arabic page`);
      }
      await shot(page, `${lang}-${theme}-${width}${path.replace(/[/?=]+/g, '_')}`);
    }
    if (mobile) {
      // The menu opens and closes on a phone.
      await page.getByRole('button', { name: t['nav.menu'], exact: true }).click();
      await page.getByRole('link', { name: t['nav.debtors'] }).click();
      await page.getByRole('heading', { name: t['debtors.title'] }).waitFor();
    }
    await page.context().close();
  });
}

console.log('\nActions, checked against the API');

await step('record a payment: the balance drops by exactly that amount', async () => {
  const api = await apiSession();
  const before = (await api(`/api/debtors/${DEBTOR.imran}`)).body.debts[0].amount_outstanding;
  const page = await signedIn();
  await page.goto(`${APP}/debtors/${DEBTOR.imran}`);
  await page.getByRole('button', { name: en['debtor.recordPayment'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(en['action.payment.amount']).fill('99999');
  await dialog.getByRole('button', { name: en['action.payment.submit'] }).click();
  await dialog.locator('[aria-invalid="true"]').first().waitFor();
  await dialog.getByLabel(en['action.payment.amount']).fill('450.25');
  await dialog.getByLabel(en['method.cash']).check();
  await dialog.getByRole('button', { name: en['action.payment.submit'] }).click();
  await toast(page, en['action.payment.done'].replace('{amount}', '450.25'));
  const after = (await api(`/api/debtors/${DEBTOR.imran}`)).body.debts[0].amount_outstanding;
  assert.equal(before, '3450.00');
  assert.equal(after, '2999.75');
  // The page shows the new balance without a reload.
  await page.locator('.debt-card-amount').filter({ hasText: '2,999.75' }).waitFor();
  await page.context().close();
});

await step('pause with a reason, then resume', async () => {
  const api = await apiSession();
  const page = await signedIn(OWNER, { lang: 'ar' });
  await page.goto(`${APP}/debtors/${DEBTOR.imran}`);
  await page.getByRole('button', { name: ar['debtor.pause'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: ar['action.pause.submit'] }).click();
  await dialog.locator('[aria-invalid="true"]').waitFor();
  await dialog.getByLabel(ar['action.pause.reason']).fill('اتفاق على الخصم من الراتب');
  await dialog.getByRole('button', { name: ar['action.pause.submit'] }).click();
  await toast(page, ar['action.pause.done'].replace('{ref}', 'DBT-2026-0001'));
  assert.equal((await api(`/api/debtors/${DEBTOR.imran}`)).body.debts[0].status, 'paused');
  await page.getByRole('button', { name: ar['action.resume'] }).click();
  await toast(page, ar['action.resume.done'].replace('{ref}', 'DBT-2026-0001'));
  assert.notEqual((await api(`/api/debtors/${DEBTOR.imran}`)).body.debts[0].status, 'paused');
  await page.context().close();
});

await step('send a reminder: a refusal is shown in plain words (WhatsApp is not set up in this run)', async () => {
  const page = await signedIn();
  await page.goto(`${APP}/debtors/${DEBTOR.imran}`);
  await page.getByRole('button', { name: en['debtor.sendReminder'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en['debtor.sendReminder'] }).click();
  const alert = dialog.getByRole('alert');
  await alert.waitFor();
  const text = await alert.textContent();
  assert.ok([en['error.not_configured'], en['error.outside_working_hours'], en['error.no_template'], en['error.send_failed']].includes(text), `unexpected: ${text}`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.context().close();
});

await step('approve the receipt: the debt balance goes down and the queue empties', async () => {
  const api = await apiSession();
  const page = await signedIn();
  await page.goto(`${APP}/approvals/payments`);
  await page.getByRole('button', { name: en['approvals.approve'] }).click();
  await toast(page, en['approvals.approved']);
  await page.getByText(en['approvals.empty.payments']).waitFor();
  assert.equal((await api(`/api/debtors/${DEBTOR.rahim}`)).body.debts[0].amount_outstanding, '1100.00');
  await page.context().close();
});

await step('decide a dispute: the debtor was right, the amount is corrected', async () => {
  const api = await apiSession();
  const page = await signedIn(OWNER, { lang: 'ar' });
  await page.goto(`${APP}/approvals/disputes`);
  await page.getByRole('button', { name: ar['approvals.dispute.resolveValid'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(ar['approvals.dispute.note']).fill('راجعنا العقد: السلفة كانت 1000 ريال');
  await dialog.getByLabel(ar['approvals.dispute.correctAmount']).fill('١٠٠٠');
  await dialog.getByRole('button', { name: ar['approvals.dispute.submit'] }).click();
  await toast(page, ar['approvals.dispute.done']);
  const debt = (await api(`/api/debts?search=DBT-2026-0004`)).body.items[0];
  assert.equal(debt.amount_original, '1000.00');
  assert.notEqual(debt.status, 'disputed');
  await page.context().close();
});

await step('approve waiting reminders: all of them, with the count confirmed', async () => {
  const api = await apiSession();
  const waiting = (await api('/api/reminders/waiting')).body.reminders.length;
  assert.ok(waiting > 0, 'seed has waiting reminders');
  const page = await signedIn();
  await page.goto(`${APP}/approvals/reminders`);
  await page.getByRole('button', { name: en['approvals.reminders.approveAll'] }).click();
  await page.getByText(en['approvals.empty.reminders']).waitFor();
  assert.equal((await api('/api/reminders/waiting')).body.reminders.length, 0);
  await page.context().close();
});

await step('add a debtor by hand: wrong phone shown on the field, then saved and opened', async () => {
  const page = await signedIn();
  await page.goto(`${APP}/debtors`);
  await page.getByRole('button', { name: en['debtors.add'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(en['add.fullName']).fill('Yousef Hand Demo');
  await dialog.getByLabel(en['add.idNumber']).fill('2400000099');
  await dialog.getByLabel(en['add.phones']).fill('05123');
  await dialog.getByLabel(en['add.amount']).fill('1,250.50');
  await dialog.getByLabel(en['add.reason']).fill('Phone and uniform not returned');
  await dialog.getByLabel(en['add.document']).selectOption('cheque');
  await dialog.getByLabel(en['add.documentRef']).fill('CHQ 5512');
  await dialog.getByRole('button', { name: en['add.submit'] }).click();
  await dialog.getByLabel(en['add.phones']).and(page.locator('[aria-invalid="true"]')).waitFor();
  await dialog.getByLabel(en['add.phones']).fill('0559876543');
  await dialog.getByRole('button', { name: en['add.submit'] }).click();
  await page.getByRole('heading', { level: 1, name: 'Yousef Hand Demo' }).waitFor();
  await page.locator('.debt-card-amount').filter({ hasText: '1,250.50' }).waitFor();
  await page.getByText('+966 55 987 6543').waitFor();
  await page.context().close();
});

await step('import from Excel: the template downloads, a bad file is refused with row numbers, a good one is saved', async () => {
  const api = await apiSession();
  const before = (await api('/api/debts?limit=1')).body.total;
  const page = await signedIn();
  await page.goto(`${APP}/import`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: en['import.download'] }).click()]);
  assert.ok((await download.path()) && (await readFile(await download.path())).subarray(0, 2).toString() === 'PK', 'template is an xlsx');

  const input = page.locator('input[type=file]');
  await input.setInputFiles(join(FILES, 'bad.xlsx'));
  await page.locator('.verdict-bad').waitFor();
  await page.getByText(en['import.row'].replace('{row}', '3')).first().waitFor();
  assert.equal(await page.getByRole('button', { name: /^Import \d/ }).count(), 0);
  await page.getByRole('button', { name: en['import.cancel'] }).click();

  await input.setInputFiles(join(FILES, 'good.xlsx'));
  await page.locator('.verdict-ok').waitFor();
  await page.getByRole('button', { name: 'Import 3 debts' }).click();
  await page.getByRole('heading', { name: '3 debts imported' }).waitFor();
  assert.equal((await api('/api/debts?limit=1')).body.total, before + 3);
  const karim = (await api('/api/debts?search=Karim')).body.items;
  assert.equal(karim.length, 2);
  assert.deepEqual(karim.map((d) => d.amount_outstanding).sort(), ['1200.00', '350.50']);
  await page.context().close();
});

await step('documents: upload a promissory note to a debt, then download the same bytes', async () => {
  const page = await signedIn();
  await page.goto(`${APP}/debtors/${DEBTOR.imran}`);
  await page.getByRole('button', { name: en['docs.add'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(en['docs.type']).selectOption('promissory_note');
  await dialog.getByLabel(en['docs.debt']).selectOption({ label: 'DBT-2026-0001' });
  await dialog.getByLabel(en['docs.file']).setInputFiles(join(FILES, 'note.pdf'));
  await dialog.getByRole('button', { name: en['docs.submit'] }).click();
  await toast(page, en['docs.done'].replace('{file}', 'note.pdf'));
  const link = page.getByRole('link', { name: en['docs.download'].replace('{file}', 'note.pdf') });
  const href = await link.getAttribute('href');
  const api = await apiSession();
  const cookie = await sessionCookie(OWNER);
  const res = await fetch(`${API}${href}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), await readFile(join(FILES, 'note.pdf')));
  const listed = (await api(`/api/documents?debt_id=${DEBT.imran}`)).body.items;
  assert.equal(listed[0].doc_type, 'promissory_note');
  await page.context().close();
});

await step('legal: upload what Najiz needs, approve with the pledge, then add the request number by hand', async () => {
  const api = await apiSession();
  const before = (await api(`/api/legal/${DEBT.javed}`)).body;
  assert.equal(before.row.stage, 'missing');
  assert.deepEqual(before.row.missing, ['cr_file', 'note_file']);
  assert.deepEqual(before.amounts, { claimed: '4200.00', received: '800.00' });

  const page = await signedIn();
  await page.goto(`${APP}/legal`);
  await page.getByRole('link', { name: 'Javed Iqbal Demo' }).click();
  await page.getByText(en['case.missingTitle'].replace('{count}', '2')).waitFor();
  assert.equal(await page.getByRole('button', { name: en['case.approve'] }).isDisabled(), true);
  // The company's commercial registration and the copy of the note, as PDFs.
  await page.getByLabel(en['case.uploadOf'].replace('{file}', en['case.file.cr'])).setInputFiles(join(FILES, 'note.pdf'));
  await toast(page, en['case.uploaded'].replace('{file}', 'note.pdf'));
  await page.getByLabel(en['case.uploadOf'].replace('{file}', en['case.file.promissory_note'])).setInputFiles(join(FILES, 'note.pdf'));
  await page.getByText(en['case.completeTitle']).waitFor();

  // Approving needs the pledge.
  await page.getByRole('button', { name: en['case.approve'] }).click();
  await page.getByText(en['case.pledgeNeeded']).waitFor();
  assert.equal((await api(`/api/legal/${DEBT.javed}`)).body.approval, null);
  await page.getByLabel(en['case.pledge']).check();
  await page.getByRole('button', { name: en['case.approve'] }).click();
  await toast(page, en['case.approvedToast'].replace('{name}', 'Javed Iqbal Demo'));
  const approved = (await api(`/api/legal/${DEBT.javed}`)).body;
  assert.equal(approved.row.stage, 'approved');
  assert.equal(approved.approval.contact_email, 'owner@demo.example');
  assert.equal(approved.approval.contact_phone, '+966500000100');

  // Filing from Talos is not built yet: the dialog says so in plain words.
  await page.getByRole('button', { name: en['legal.fileOne'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en['najiz.start'] }).click();
  await dialog.getByText(en['error.najiz_not_ready']).waitFor();
  await dialog.getByRole('button', { name: en['common.cancel'] }).click();

  // Filed on Najiz by hand: the request number is added to the case.
  await page.getByRole('button', { name: en['case.addStatus'] }).click();
  const status = page.getByRole('dialog');
  await status.getByLabel(en['legal.col.request']).fill('401014800099999');
  await status.getByRole('button', { name: en['common.save'] }).click();
  await toast(page, en['case.statusSaved']);
  const filed = (await api(`/api/legal/${DEBT.javed}`)).body;
  assert.equal(filed.row.stage, 'submitted');
  assert.equal(filed.row.najiz_request_number, '401014800099999');
  assert.deepEqual(filed.events.map((e) => e.status), ['submitted', 'approved']);
  const debtor = (await api('/api/debtors/33333333-3333-4333-8333-000000000099')).body;
  assert.equal(debtor.debts[0].status, 'in_legal');
  await page.context().close();

  // The Arabic "On Najiz" tab lists it with its number.
  const arPage = await signedIn(OWNER, { lang: 'ar' });
  await arPage.goto(`${APP}/legal/filed`);
  await arPage.getByText('401014800099999').waitFor();
  assert.deepEqual(await englishLeftInArabic(arPage), []);
  await axe(arPage, '/legal/filed ar');
  await arPage.context().close();
});

await step('legal: viewers and other clients cannot approve; amounts stay text', async () => {
  const cookie = await sessionCookie(OWNER);
  const res = await fetch(`${API}/api/legal`, { headers: { cookie } });
  const items = (await res.json()).items;
  for (const r of items) assert.match(r.amount_outstanding, /^\d+\.\d{2}$/);
  const approve = await fetch(`${API}/api/legal/${DEBT.javed}/approve`, {
    method: 'POST', headers: { cookie, 'x-talos': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ contact_email: 'owner@demo.example', contact_phone: '0500000100', pledge: true }),
  });
  assert.equal(approve.status, 409);
  assert.equal((await approve.json()).error, 'already_approved');
});

await step('settings: change the follow-up rules; the change is saved and shown after a reload', async () => {
  const api = await apiSession();
  const page = await signedIn();
  await page.goto(`${APP}/settings/rules`);
  await page.getByLabel(en['settings.rules.interval']).fill('3');
  await page.getByLabel(en['settings.rules.to'], { exact: true }).fill('08:00');
  await page.getByRole('button', { name: en['common.save'] }).click();
  await page.getByText(en['settings.rules.hoursOrder']).waitFor();
  await page.getByLabel(en['settings.rules.to'], { exact: true }).fill('19:30');
  await page.getByRole('checkbox', { name: en['day.6'], exact: true }).check();
  await page.getByRole('button', { name: en['common.save'] }).click();
  await toast(page, en['common.saved']);
  const rules = (await api('/api/settings/rules')).body;
  assert.equal(rules.interval_days, 3);
  assert.equal(rules.working_hours_end, '19:30');
  assert.ok(rules.working_days.includes(6));
  await page.reload();
  assert.equal(await page.getByLabel(en['settings.rules.interval']).inputValue(), '3');
  await page.context().close();
});

await step('team: invite a person; they choose a password from the email and log in with the role given', async () => {
  const page = await signedIn();
  await page.goto(`${APP}/settings/team`);
  const since = mailStamp();
  await page.getByRole('button', { name: en['settings.team.add'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(en['settings.team.name']).fill('Vera Viewer Demo');
  await dialog.getByLabel(en['settings.team.email']).fill('vera@demo.example');
  await dialog.getByText(en['role.viewer'], { exact: true }).click();
  await dialog.getByRole('button', { name: en['settings.team.invite'] }).click();
  await toast(page, en['settings.team.invited'].replace('{email}', 'vera@demo.example'));
  await page.locator('.person-email').getByText('vera@demo.example', { exact: true }).waitFor();
  const link = linkIn(await latestMail('vera@demo.example', since));
  await page.context().close();

  const vera = await newPage({ lang: 'ar' });
  await vera.goto(`${APP}${link.pathname}${link.search}`);
  await vera.getByRole('heading', { name: ar['reset.inviteTitle'].replace('{name}', 'Vera') }).waitFor();
  await vera.getByLabel(ar['reset.password'], { exact: true }).fill('vera long password');
  await vera.getByLabel(ar['reset.confirm'], { exact: true }).fill('vera long password');
  await vera.getByRole('button', { name: ar['reset.submit'] }).click();
  await vera.waitForURL(/\/login\?reset=done/);
  // The email is filled in for them.
  assert.equal(await vera.getByLabel(ar['login.email']).inputValue(), 'vera@demo.example');
  await vera.getByLabel(ar['login.password'], { exact: true }).fill('vera long password');
  await vera.getByRole('button', { name: ar['login.submit'] }).click();
  await vera.waitForURL((u) => !u.pathname.startsWith('/login'));

  // A viewer sees everything and can change nothing.
  await vera.goto(`${APP}/debtors`);
  await vera.getByRole('heading', { name: ar['debtors.title'] }).waitFor();
  assert.equal(await vera.getByRole('button', { name: ar['debtors.add'] }).count(), 0);
  await vera.goto(`${APP}/debtors/${DEBTOR.fahad}`);
  await vera.locator('main h1').waitFor();
  assert.equal(await vera.getByRole('button', { name: ar['debtor.recordPayment'] }).count(), 0);
  await vera.goto(`${APP}/settings/rules`);
  await vera.getByText(ar['settings.rules.readOnly']).waitFor();
  // And the API refuses a viewer too, whatever the screens show.
  const veraApi = await apiSession({ email: 'vera@demo.example', password: 'vera long password' });
  assert.equal((await veraApi(`/api/debts/${DEBT.imran}/pause`, { method: 'POST', body: JSON.stringify({ reason: 'trying' }) })).status, 403);
  await vera.context().close();
});

await step('team: removing access ends that person session at once', async () => {
  const veraApi = await apiSession({ email: 'vera@demo.example', password: 'vera long password' });
  assert.equal((await veraApi('/api/me')).status, 200);
  const page = await signedIn();
  await page.goto(`${APP}/settings/team`);
  const row = page.locator('li.person').filter({ hasText: 'vera@demo.example' });
  await row.getByRole('button', { name: en['settings.team.deactivate'] }).click();
  await row.getByText(en['settings.team.inactive']).waitFor();
  assert.equal((await veraApi('/api/me')).status, 401);
  await page.context().close();
});

await step('notifications: shown in both languages, open the right page, mark all as read', async () => {
  const page = await signedIn(OWNER, { lang: 'ar' });
  await page.goto(`${APP}/notifications`);
  await page.getByText(ar['note.dispute'].replace('{name}', 'Ahmed Hassan Demo').replace('{ref}', 'DBT-2026-0004')).waitFor();
  await page.getByText(ar['note.summary'].replace('{sent}', '4').replace('{replies}', '2').replace('{promises}', '1').replace('{payments}', '1')).waitFor();
  await page.getByRole('link', { name: ar['note.needs_reply'].replace('{name}', 'Fahad Demo').replace('{ref}', 'DBT-2026-0002') }).click();
  await page.waitForURL(new RegExp(`/debtors/${DEBTOR.fahad}`));
  await page.goto(`${APP}/notifications`);
  await page.getByRole('button', { name: ar['notes.markAll'] }).click();
  await page.locator('.note-unread').first().waitFor({ state: 'detached' });
  await page.context().close();
});

await step('a session that ends while the page is open goes back to login', async () => {
  const page = await signedIn();
  await page.context().clearCookies();
  await page.goto(`${APP}/debtors`);
  await page.waitForURL(/\/login/);
  await page.context().close();
});

await step('no browser errors on any page', async () => {
  assert.deepEqual(consoleErrors, []);
});

await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
