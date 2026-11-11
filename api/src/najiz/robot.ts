/**
 * The Najiz robot: drives Najiz Business in a real browser, following
 * docs/najiz-filing.md step by step (5.4 filing, 5.5 status checks).
 *
 * It finds everything by the Arabic words Najiz shows (labels, buttons,
 * headings), never by page structure, and checks it is on the page it
 * expects before every action. If not, it stops (`NajizStop`) and the worker
 * tells the client's staff. It never guesses (Najiz rule 6).
 *
 * The words come from Sal's screen recordings. They are all in `WORDS`
 * below: when Najiz changes a word, change it here and in the doc.
 *
 * Session (Najiz rule 3): each run gets a fresh browser context that is only
 * in memory and is closed at the end; nothing about it is written anywhere.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import {
  NajizStop, splitAmount,
  type Filed, type FileToUpload, type FilingStep, type NajizFiling, type NajizSite, type NajizStatus,
} from './site.js';

/** Every word the robot looks for on Najiz. */
export const WORDS = {
  // A. Sign in
  business: 'أعمال',
  nafathLogin: 'تسجيل الدخول عبر النفاذ الوطني',
  ownerId: 'رقم الهوية',
  login: 'تسجيل الدخول',
  nafathNumber: 'رقم الطلب',
  accounts: 'الحسابات المفعلة',
  // B. New execution request
  execution: 'التنفيذ',
  newRequest: 'طلب جديد',
  electronicRequest: 'تقديم طلب تنفيذ إلكتروني',
  next: 'التالي',
  stepType: 'نوع الطلب',
  stepRequester: 'طالب التنفيذ',
  stepDebtor: 'المنفذ ضده',
  stepContent: 'مضمون الطلب',
  stepReview: 'مراجعة الطلب',
  // 1. Request type
  category: 'تصنيف الطلب', categoryValue: 'تنفيذ مالي',
  mainType: 'النوع الرئيسي', mainTypeValue: 'أوراق تجارية',
  subType: 'النوع الفرعي', subTypeValue: 'سند لأمر',
  capacity: 'صفة مقدم الطلب', capacityValue: 'بالنيابة عن جهة اعتبارية',
  pledge: 'أقر',
  // 2. Requester
  entityType: 'نوع الجهة', entityTypeValue: 'شركة مسجلة في وزارة التجارة',
  unifiedNumber: 'الرقم الموحد للمنشأة',
  verify: 'تحقق',
  representation: 'نوع التمثيل', representationValue: 'ممثل نظامي',
  crFile: 'السجل التجاري',
  contractFile: 'عقد التأسيس',
  partnersFile: 'قرارات الشركاء',
  email: 'البريد الإلكتروني',
  mobile: 'رقم الجوال',
  bank: 'البنك',
  iban: 'رقم الآيبان',
  // 3. Debtor
  nationality: 'الجنسية',
  idType: 'نوع الهوية',
  idTypes: { national_id: 'هوية وطنية', iqama: 'إقامة', passport: 'جواز سفر' },
  idNumber: 'رقم الهوية',
  firstName: 'الاسم الأول',
  fatherName: 'اسم الأب',
  grandfatherName: 'اسم الجد',
  familyName: 'اسم العائلة',
  workAddressKnown: 'هل عنوان العمل معروف',
  yes: 'نعم',
  no: 'لا',
  // 4. Request content. Amounts are typed as riyals and halalas.
  faceAmount: 'المبلغ المدون في السند',
  partReceived: 'هل تم استلام جزء من المبلغ',
  received: 'المبلغ المستلم',
  remaining: 'المبلغ المتبقي',
  executeAll: 'هل تريد تنفيذ كامل المبلغ المتبقي',
  riyals: 'ريال',
  halalas: 'هللة',
  currency: 'العملة', currencyValue: 'ريال سعودي',
  noteNumber: 'رقم السند',
  issueDate: 'تاريخ تحرير السند',
  issueCountry: 'دولة التحرير',
  issueCity: 'مدينة التحرير',
  paymentPlace: 'مكان الوفاء',
  dueStatus: 'حالة الاستحقاق', dueOnDate: 'مستحق في تاريخ', dueOnDemand: 'مستحق عند الاطلاع',
  dueDate: 'تاريخ الاستحقاق',
  noteFile: 'صورة السند',
  // 5. Review and send
  court: 'محكمة التنفيذ',
  send: 'حفظ وإرسال',
  sent: 'تم تقديم الطلب بنجاح',
  requestNumber: 'رقم الطلب',
  // C. Status
  search: 'بحث',
  status: 'حالة الطلب',
  circuit: 'الدائرة',
} as const;

/** Cities people type in English on the case page, as Najiz lists them. Arabic is used as typed. */
const CITIES: Record<string, string> = {
  jeddah: 'جدة', riyadh: 'الرياض', makkah: 'مكة المكرمة', mecca: 'مكة المكرمة', madinah: 'المدينة المنورة',
  medina: 'المدينة المنورة', dammam: 'الدمام', khobar: 'الخبر', 'al khobar': 'الخبر', taif: 'الطائف',
  tabuk: 'تبوك', hail: 'حائل', buraydah: 'بريدة', abha: 'أبها', jazan: 'جازان', najran: 'نجران', yanbu: 'ينبع',
};

export function cityInArabic(city: string): string | null {
  const c = city.trim();
  if (/[؀-ۿ]/.test(c)) return c;
  return CITIES[c.toLowerCase()] ?? null;
}

/** A country code (PK) as Najiz writes it in Arabic (باكستان). */
export function countryInArabic(code: string): string {
  return new Intl.DisplayNames(['ar'], { type: 'region' }).of(code.toUpperCase()) ?? code;
}

/** YYYY-MM-DD to DD/MM/YYYY, as Najiz shows Gregorian dates. */
export function najizDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Text with Arabic digits made Western, without commas or spaces: for comparing values on the review page. */
export function plain(text: string): string {
  return text
    .replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (x) => String(x.charCodeAt(0) - 0x06f0))
    .replace(/[\s,٬‏‎]/g, '');
}

export interface RobotOptions {
  /** Where Najiz is: https://najiz.sa in production, a fake Najiz in tests. */
  baseUrl: string;
  browser: () => Promise<Browser>;
  /** How long to wait for a page or a field before stopping. */
  stepTimeoutMs?: number;
  /** How long to wait for the confirmation after "send". */
  sendTimeoutMs?: number;
}

export class PlaywrightNajizSite implements NajizSite {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly step: number;
  private readonly sendWait: number;

  constructor(private readonly opts: RobotOptions) {
    this.step = opts.stepTimeoutMs ?? 20_000;
    this.sendWait = opts.sendTimeoutMs ?? 60_000;
  }

  private get p(): Page {
    if (!this.page) throw new NajizStop('unexpected_page', 'Najiz is not open');
    return this.page;
  }

  async startSignIn(ownerIdNumber: string) {
    const browser = await this.opts.browser();
    // A fresh session that only lives in memory, closed in close().
    this.context = await browser.newContext({ locale: 'ar-SA', acceptDownloads: false, serviceWorkers: 'block' });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.step);
    try {
      await this.p.goto(this.opts.baseUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      throw new NajizStop('najiz_error', 'Najiz did not open');
    }
    await this.click(WORDS.business, 'Najiz home page');
    await this.click(WORDS.nafathLogin, 'Business sign-in');
    await this.fill(WORDS.ownerId, ownerIdNumber, { partial: true });
    await this.click(WORDS.login, 'sign-in button');
    await this.see(WORDS.nafathNumber, 'the Nafath number');
    const n = plain(await this.valueOf(WORDS.nafathNumber));
    if (!/^[0-9]{1,3}$/.test(n)) throw new NajizStop('unexpected_page', 'Could not read the Nafath number');
    return { nafathNumber: n };
  }

  async signedIn() {
    try {
      await this.stopOnCaptcha();
      return await this.p.getByText(WORDS.accounts, { exact: true }).first().isVisible();
    } catch (err) {
      if (err instanceof NajizStop) throw err;
      return false; // the page was changing while we looked; look again next time
    }
  }

  async chooseCompany(unifiedNumber: string) {
    await this.see(WORDS.accounts, 'the list of establishments');
    const row = this.p.locator('li, tr, [role=row], [role=listitem], .card, button, a').filter({ hasText: unifiedNumber }).last();
    if (!(await row.count())) {
      throw new NajizStop('company_not_found', 'The owner cannot act for an establishment with this unified number on Najiz');
    }
    const button = row.getByRole('button').or(row.getByRole('link')).first();
    await ((await button.count()) ? button : row).click();
    await this.see(WORDS.execution, 'the Najiz Business home page');
  }

  async fileNote(f: NajizFiling, hooks: { onStep(step: FilingStep): Promise<void>; mayStillSend(): Promise<boolean> }): Promise<Filed> {
    const W = WORDS;
    const city = cityInArabic(f.note.issueCity);
    if (!city) throw new NajizStop('details_differ', `The city "${f.note.issueCity}" is not in the Najiz list. Write it in Arabic on the case page.`);

    // 1. Request type
    await hooks.onStep('request_type');
    await this.click(W.execution, 'the Najiz Business menu');
    await this.click(W.newRequest, 'the execution page');
    await this.click(W.electronicRequest, 'the new request choices');
    await this.see(W.stepType, 'step 1, request type');
    await this.choose(W.category, W.categoryValue);
    await this.choose(W.mainType, W.mainTypeValue);
    await this.choose(W.subType, W.subTypeValue);
    await this.choose(W.capacity, W.capacityValue);
    await this.tick(W.pledge);
    await this.next(W.stepRequester);

    // 2. Requester
    await hooks.onStep('requester');
    await this.choose(W.entityType, W.entityTypeValue);
    await this.fill(W.unifiedNumber, f.unifiedNumber);
    await this.verifyAfter(W.unifiedNumber);
    await this.choose(W.representation, W.representationValue);
    await this.upload(W.crFile, f.crFile);
    if (f.contractFile) await this.upload(W.contractFile, f.contractFile);
    if (f.partnersFile) await this.upload(W.partnersFile, f.partnersFile);
    await this.fill(W.email, f.contactEmail);
    await this.fill(W.mobile, f.contactPhone);
    await this.choose(W.bank, f.bankName, 'details_differ');
    await this.fill(W.iban, f.iban);
    await this.verifyAfter(W.iban);
    await this.next(W.stepDebtor);

    // 3. Debtor
    await hooks.onStep('debtor');
    const d = f.debtor;
    await this.choose(W.nationality, countryInArabic(d.nationality), 'details_differ');
    await this.choose(W.idType, W.idTypes[d.idType]);
    await this.fill(W.idNumber, d.idNumber);
    await this.fill(W.firstName, d.firstName);
    if (d.fatherName) await this.fill(W.fatherName, d.fatherName);
    if (d.grandfatherName) await this.fill(W.grandfatherName, d.grandfatherName);
    await this.fill(W.familyName, d.familyName);
    if (d.phone) await this.fill(W.mobile, d.phone);
    await this.radio(W.workAddressKnown, W.no);
    await this.next(W.stepContent);

    // 4. Request content
    await hooks.onStep('content');
    const n = f.note;
    await this.amount(W.faceAmount, n.faceAmount);
    const partPaid = /[1-9]/.test(n.received);
    await this.radio(W.partReceived, partPaid ? W.yes : W.no);
    if (partPaid) await this.amount(W.received, n.received);
    await this.amount(W.remaining, n.claimed);
    await this.radio(W.executeAll, W.yes);
    await this.choose(W.currency, W.currencyValue);
    if (n.referenceNumber) await this.fill(W.noteNumber, n.referenceNumber);
    await this.fill(W.issueDate, najizDate(n.issueDate));
    await this.choose(W.issueCountry, countryInArabic(n.issueCountry), 'details_differ');
    await this.choose(W.issueCity, city, 'details_differ');
    // The place of payment is the place the note was written (Sal, 10 November 2026).
    await this.choose(W.paymentPlace, city, 'details_differ');
    await this.radio(W.dueStatus, n.dueOnDemand ? W.dueOnDemand : W.dueOnDate);
    if (!n.dueOnDemand && n.dueDate) await this.fill(W.dueDate, najizDate(n.dueDate));
    await this.upload(W.noteFile, n.file);
    await this.next(W.stepReview);

    // 5. Review: every value must be the one in Talos, then send.
    await hooks.onStep('sending');
    const page = plain(await this.p.locator('body').innerText());
    const expected: [string, string][] = [
      ['the unified number', f.unifiedNumber],
      ['the IBAN', f.iban],
      ['the debtor ID number', d.idNumber],
      ['the remaining amount', splitAmount(n.claimed).riyals],
      ['the amount in the note', splitAmount(n.faceAmount).riyals],
      ['the court', W.court],
      ...(n.referenceNumber ? [['the note number', n.referenceNumber] as [string, string]] : []),
    ];
    for (const [what, value] of expected) {
      if (!page.includes(plain(value))) {
        throw new NajizStop('details_differ', `On the review page, ${what} is not the one in Talos`);
      }
    }
    if (!(await hooks.mayStillSend())) throw new NajizStop('cancelled', 'Stopped by staff before sending');
    await this.click(W.send, 'the review page');

    // From here the request may be on Najiz, so every stop says so.
    try {
      await this.p.getByText(W.sent).first().waitFor({ state: 'visible', timeout: this.sendWait });
    } catch {
      const alert = await this.alertText();
      throw new NajizStop(
        alert ? 'najiz_error' : 'unexpected_page',
        alert ? `After sending, Najiz said: ${alert}` : 'After sending, Najiz did not show the confirmation',
        true,
      );
    }
    const number = plain(await this.valueOf(W.requestNumber).catch(() => ''));
    const requestNumber = /^[0-9]{6,20}$/.test(number) ? number : /([0-9]{6,20})/.exec(plain(await this.p.locator('body').innerText()))?.[1];
    if (!requestNumber) throw new NajizStop('unexpected_page', 'Najiz confirmed the request but the request number could not be read', true);
    const receipt = await this.p.screenshot({ fullPage: true, type: 'png' });
    return { requestNumber, receipt };
  }

  async checkStatus(requestNumber: string): Promise<NajizStatus> {
    await this.click(WORDS.execution, 'the Najiz Business menu');
    await this.fill(WORDS.requestNumber, requestNumber);
    await this.click(WORDS.search, 'the execution list');
    const row = this.p.locator('tr, [role=row], li, .card').filter({ hasText: requestNumber }).first();
    try {
      await row.waitFor({ state: 'visible' });
    } catch {
      throw new NajizStop('unexpected_page', `Request ${requestNumber} was not found in the Najiz execution list`);
    }
    const open = row.getByRole('link').or(row.getByRole('button')).first();
    await ((await open.count()) ? open : row).click();
    await this.see(WORDS.status, 'the request page');
    const status = (await this.valueOf(WORDS.status)).trim();
    if (!status) throw new NajizStop('unexpected_page', 'The request status could not be read');
    const circuit = (await this.valueOf(WORDS.circuit).catch(() => '')).trim() || null;
    return { status, circuit };
  }

  async close() {
    const c = this.context;
    this.context = null;
    this.page = null;
    await c?.close().catch(() => undefined);
  }

  // ---- small steps, each checking the page first ----

  /** Najiz asked for a picture check: stop, a person has to look. */
  private async stopOnCaptcha() {
    const captcha = this.p.locator(
      'iframe[src*="captcha" i], iframe[title*="captcha" i], [class*="captcha" i], [id*="captcha" i], img[alt*="captcha" i]',
    );
    if (await captcha.count()) throw new NajizStop('captcha', 'Najiz asked for a picture check (captcha)');
  }

  /** Najiz's own message on the page, if it shows one. */
  private async alertText(): Promise<string | null> {
    const a = this.p.locator('[role=alert], .alert-danger, .error-message').first();
    if (!(await a.count())) return null;
    const text = (await a.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, 200) : null;
  }

  private async fail(what: string): Promise<never> {
    await this.stopOnCaptcha();
    const alert = await this.alertText();
    if (alert) throw new NajizStop('najiz_error', `Najiz said: ${alert}`);
    throw new NajizStop('unexpected_page', what);
  }

  private async see(text: string, where: string) {
    await this.stopOnCaptcha();
    try {
      await this.p.getByText(text, { exact: true }).first().waitFor({ state: 'visible' });
    } catch {
      await this.fail(`Expected to see "${text}" (${where})`);
    }
  }

  private async click(text: string, where: string) {
    await this.stopOnCaptcha();
    const target = this.p
      .getByRole('button', { name: text, exact: true })
      .or(this.p.getByRole('link', { name: text, exact: true }))
      .or(this.p.getByRole('tab', { name: text, exact: true }))
      .first();
    try {
      await target.waitFor({ state: 'visible' });
      await target.click();
    } catch {
      await this.fail(`Could not find "${text}" on ${where}`);
    }
  }

  private async field(label: string, partial = false): Promise<Locator> {
    const f = this.p.getByLabel(label, { exact: !partial }).first();
    try {
      await f.waitFor({ state: 'visible' });
    } catch {
      await this.fail(`Could not find the field "${label}"`);
    }
    return f;
  }

  private async fill(label: string, value: string, opts: { partial?: boolean } = {}) {
    await (await this.field(label, opts.partial)).fill(value);
  }

  private async amount(label: string, value: string) {
    const { riyals, halalas } = splitAmount(value);
    await this.fill(`${label} (${WORDS.riyals})`, riyals);
    await this.fill(`${label} (${WORDS.halalas})`, halalas);
  }

  /** Pick an option in a list. A missing option is a value Najiz does not know (`details_differ`) or a changed page. */
  private async choose(label: string, option: string, missing: 'details_differ' | 'unexpected_page' = 'unexpected_page') {
    const f = await this.field(label);
    const tag = await f.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      const values = await f.locator('option').allInnerTexts();
      if (!values.some((v) => v.trim() === option)) throw new NajizStop(missing, `"${option}" is not in the Najiz list "${label}"`);
      await f.selectOption({ label: option });
      return;
    }
    await f.click();
    const o = this.p.getByRole('option', { name: option, exact: true }).first();
    try {
      await o.waitFor({ state: 'visible', timeout: Math.min(this.step, 5000) });
    } catch {
      throw new NajizStop(missing, `"${option}" is not in the Najiz list "${label}"`);
    }
    await o.click();
  }

  /** One answer in a group of choices, for example "نعم" under a question. */
  private async radio(question: string, answer: string) {
    const group = this.p
      .getByRole('radiogroup', { name: question })
      .or(this.p.getByRole('group', { name: question }))
      .first();
    try {
      await group.waitFor({ state: 'visible' });
    } catch {
      await this.fail(`Could not find the question "${question}"`);
    }
    await group.getByLabel(answer, { exact: true }).check();
  }

  private async tick(label: string) {
    const box = this.p.getByRole('checkbox', { name: label }).first();
    try {
      await box.waitFor({ state: 'visible' });
    } catch {
      await this.fail(`Could not find the pledge "${label}"`);
    }
    await box.check();
  }

  private async upload(label: string, file: FileToUpload) {
    const input = this.p.getByLabel(label, { exact: true }).first();
    if (!(await input.count())) await this.fail(`Could not find where to upload "${label}"`);
    await input.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.bytes });
  }

  /** Press the "تحقق" button that follows a field, then make sure Najiz did not refuse it. */
  private async verifyAfter(label: string) {
    const f = await this.field(label);
    const button = f.locator(`xpath=following::button[normalize-space()="${WORDS.verify}"][1]`);
    if (!(await button.count())) await this.fail(`Could not find "${WORDS.verify}" after "${label}"`);
    await button.click();
    await this.p.waitForLoadState('networkidle').catch(() => undefined);
    const alert = await this.alertText();
    if (alert) throw new NajizStop('details_differ', `Najiz did not accept ${label}: ${alert}`);
  }

  /** Go to the next step, and check it is the one we expect (its heading, not the list of steps). */
  private async next(nextStep: string) {
    await this.click(WORDS.next, 'the request form');
    await this.stopOnCaptcha();
    try {
      await this.p.getByRole('heading', { name: nextStep, exact: true }).first().waitFor({ state: 'visible' });
    } catch {
      await this.fail(`Expected the step "${nextStep}"`);
    }
  }

  /** The value shown next to a label: <dt>label</dt><dd>value</dd>, a table cell, or "label: value". */
  private async valueOf(label: string): Promise<string> {
    const el = this.p.getByText(label, { exact: true }).first();
    await el.waitFor({ state: 'visible' });
    return el.evaluate((node) => {
      const next = node.nextElementSibling ?? node.parentElement?.nextElementSibling;
      return (next?.textContent ?? '').trim();
    });
  }
}

/** One Chromium for the whole worker, opened when first needed. Each run gets its own context. */
export function sharedChromium() {
  let browser: Promise<Browser> | null = null;
  return {
    get: () => (browser ??= chromium.launch({ headless: true })),
    close: async () => {
      const b = browser;
      browser = null;
      if (b) await (await b).close().catch(() => undefined);
    },
  };
}
