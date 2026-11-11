/**
 * A fake Najiz Business for the robot tests: the same pages, words and steps
 * as docs/najiz-filing.md, as plain HTML forms. It never talks to the real
 * Najiz. Tests can make it act up (captcha, a changed page, a wrong value,
 * no answer after sending) and read back what was filed.
 */
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

type Page = 'home' | 'business' | 'login' | 'nafath' | 'accounts' | 'dashboard' | 'execution' | 'new' | 'form1' | 'form2' | 'form3' | 'form4' | 'review' | 'sent' | 'request';

export interface FakeRequest {
  number: string;
  fields: Record<string, string>;
  files: Record<string, { name: string; size: number; type: string }>;
}

export interface FakeNajizOptions {
  /** Show a captcha on this page. */
  captchaOn?: Page;
  /** Rename a label, as if Najiz changed its page. */
  rename?: { from: string; to: string };
  /** Show a different IBAN on the review page. */
  reviewIban?: string;
  /** After "send", show nothing useful. */
  hangAfterSend?: boolean;
  /** The owner's establishments (unified numbers). */
  companies?: string[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function startFakeNajiz() {
  const sessions = new Map<string, { approved: boolean; fields: Record<string, string>; files: FakeRequest['files']; company?: string }>();
  const requests: FakeRequest[] = [];
  let opts: FakeNajizOptions = {};
  let approveNafath = false;
  let nextNumber = 4471000100;
  const statuses = new Map<string, { status: string; circuit: string }>();

  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

  const label = (text: string) => (opts.rename?.from === text ? opts.rename.to : text);
  const page = (name: Page, body: string, extra = '') => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">${extra}<title>ناجز</title></head>
<body>${['home', 'business', 'login', 'nafath', 'accounts'].includes(name) ? '' : '<nav><a href="/execution">التنفيذ</a></nav>'}<main>${opts.captchaOn === name ? '<div class="g-captcha">captcha</div>' : ''}${body}</main></body></html>`;
  const input = (id: string, text: string, type = 'text') => `<p><label for="${id}">${esc(label(text))}</label><input id="${id}" name="${id}" type="${type}"></p>`;
  const select = (id: string, text: string, options: string[]) =>
    `<p><label for="${id}">${esc(label(text))}</label><select id="${id}" name="${id}"><option value="">اختر</option>${options
      .map((o) => `<option>${esc(o)}</option>`)
      .join('')}</select></p>`;
  const radio = (id: string, question: string, answers: string[]) =>
    `<fieldset><legend>${esc(label(question))}</legend>${answers
      .map((a, i) => `<label><input type="radio" name="${id}" value="${esc(a)}" id="${id}-${i}"> ${esc(a)}</label>`)
      .join('')}</fieldset>`;
  const verify = '<button type="button">تحقق</button>';
  const steps = (n: number) =>
    `<ol class="steps">${['نوع الطلب', 'طالب التنفيذ', 'المنفذ ضده', 'مضمون الطلب', 'مراجعة الطلب']
      .map((s, i) => `<li${i + 1 === n ? ' aria-current="step"' : ''}>${s}</li>`)
      .join('')}</ol><h2>${['نوع الطلب', 'طالب التنفيذ', 'المنفذ ضده', 'مضمون الطلب', 'مراجعة الطلب'][n - 1]}</h2>`;
  const form = (action: string, inner: string) =>
    `<form method="post" action="${action}" enctype="multipart/form-data">${inner}<button type="submit">التالي</button></form>`;
  const amount = (id: string, text: string) => input(`${id}_r`, `${text} (ريال)`) + input(`${id}_h`, `${text} (هللة)`);

  const COUNTRIES = ['المملكة العربية السعودية', 'باكستان', 'بنغلاديش', 'الهند'];
  const CITIES = ['جدة', 'الرياض', 'مكة المكرمة', 'الدمام'];
  const BANKS = ['Demo Bank', 'مصرف الراجحي'];

  const pages: Record<string, () => string> = {
    form1: () =>
      page('form1', steps(1) + form('/form/1',
        select('category', 'تصنيف الطلب', ['تنفيذ مالي', 'تنفيذ غير مالي']) +
        select('main', 'النوع الرئيسي', ['أوراق تجارية', 'عقود']) +
        select('sub', 'النوع الفرعي', ['سند لأمر', 'شيك', 'كمبيالة']) +
        select('capacity', 'صفة مقدم الطلب', ['أصالة عن نفسه', 'بالنيابة عن جهة اعتبارية']) +
        '<p><label><input type="checkbox" name="pledge" id="pledge"> أقر بصحة جميع البيانات والمستندات</label></p>')),
    form2: () =>
      page('form2', steps(2) + form('/form/2',
        select('entity', 'نوع الجهة', ['شركة مسجلة في وزارة التجارة', 'جهة حكومية']) +
        input('unified', 'الرقم الموحد للمنشأة') + verify +
        select('representation', 'نوع التمثيل', ['وكيل', 'ممثل نظامي']) +
        input('cr', 'السجل التجاري', 'file') + input('contract', 'عقد التأسيس', 'file') + input('partners', 'قرارات الشركاء', 'file') +
        input('email', 'البريد الإلكتروني') + input('mobile', 'رقم الجوال') +
        select('bank', 'البنك', BANKS) + input('iban', 'رقم الآيبان') + verify)),
    form3: () =>
      page('form3', steps(3) + form('/form/3',
        select('nationality', 'الجنسية', COUNTRIES) +
        select('id_type', 'نوع الهوية', ['هوية وطنية', 'إقامة', 'جواز سفر']) +
        input('id_number', 'رقم الهوية') + input('first', 'الاسم الأول') + input('father', 'اسم الأب') +
        input('grandfather', 'اسم الجد') + input('family', 'اسم العائلة') + input('debtor_mobile', 'رقم الجوال') +
        radio('work', 'هل عنوان العمل معروف', ['نعم', 'لا']))),
    form4: () =>
      page('form4', steps(4) + form('/form/4',
        amount('face', 'المبلغ المدون في السند') +
        radio('part', 'هل تم استلام جزء من المبلغ', ['نعم', 'لا']) +
        amount('received', 'المبلغ المستلم') + amount('remaining', 'المبلغ المتبقي') +
        radio('all', 'هل تريد تنفيذ كامل المبلغ المتبقي', ['نعم', 'لا']) +
        select('currency', 'العملة', ['ريال سعودي', 'دولار أمريكي']) +
        input('note_number', 'رقم السند') + input('issue_date', 'تاريخ تحرير السند') +
        select('issue_country', 'دولة التحرير', COUNTRIES) + select('issue_city', 'مدينة التحرير', CITIES) +
        select('payment_place', 'مكان الوفاء', CITIES) +
        radio('due', 'حالة الاستحقاق', ['مستحق في تاريخ', 'مستحق عند الاطلاع']) +
        input('due_date', 'تاريخ الاستحقاق') + input('note', 'صورة السند', 'file'))),
  };

  function sessionOf(req: { headers: { cookie?: string } }, reply: { header(k: string, v: string): unknown }) {
    const id = /s=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (id && sessions.has(id)) return sessions.get(id)!;
    const nid = randomUUID();
    const s: { approved: boolean; fields: Record<string, string>; files: FakeRequest['files']; company?: string } = { approved: false, fields: {}, files: {} };
    sessions.set(nid, s);
    reply.header('set-cookie', `s=${nid}; Path=/; HttpOnly`);
    return s;
  }
  const html = (reply: { type(t: string): { send(b: string): unknown } }, body: string) => reply.type('text/html; charset=utf-8').send(body);

  async function readForm(req: { parts(): AsyncIterable<{ type: string; fieldname: string; value?: unknown; filename?: string; mimetype?: string; toBuffer?: () => Promise<Buffer> }> }, s: { fields: Record<string, string>; files: FakeRequest['files'] }) {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer!();
        if (buf.length) s.files[part.fieldname] = { name: part.filename!, size: buf.length, type: part.mimetype! };
      } else if (typeof part.value === 'string' && part.value !== '') {
        s.fields[part.fieldname] = part.value;
      }
    }
  }

  app.get('/', async (_q, r) => html(r, page('home', '<a href="/business">أعمال</a>')));
  app.get('/business', async (_q, r) => html(r, page('business', '<a href="/login">تسجيل الدخول عبر النفاذ الوطني</a>')));
  app.get('/login', async (q, r) => {
    sessionOf(q, r);
    return html(r, page('login', '<form method="post" action="/login" enctype="multipart/form-data">' + input('owner', 'رقم الهوية الوطنية أو الإقامة') + '<button type="submit">تسجيل الدخول</button></form>'));
  });
  app.post('/login', async (q, r) => {
    const s = sessionOf(q, r);
    await readForm(q, s);
    return r.redirect('/nafath', 303);
  });
  app.get('/nafath', async (q, r) => {
    const s = sessionOf(q, r);
    if (approveNafath) s.approved = true;
    if (!s.approved) {
      return html(r, page('nafath', '<p>افتح تطبيق نفاذ واختر الرقم</p><dl><dt>رقم الطلب</dt><dd>42</dd></dl>', '<meta http-equiv="refresh" content="1">'));
    }
    const companies = opts.companies ?? ['7000000001'];
    return html(r, page('accounts', `<h2>الحسابات المفعلة</h2><ul>${companies
      .map((u) => `<li>منشأة تجريبية ${u}<form method="post" action="/choose/${u}" enctype="multipart/form-data"><button type="submit">دخول</button></form></li>`)
      .join('')}</ul>`));
  });
  app.post('/choose/:u', async (q, r) => {
    const s = sessionOf(q, r);
    await readForm(q, { fields: {}, files: {} });
    s.company = (q.params as { u: string }).u;
    return r.redirect('/dashboard', 303);
  });
  const signedIn = (s: { approved: boolean; company?: string }) => s.approved && !!s.company;
  app.get('/dashboard', async (q, r) => {
    if (!signedIn(sessionOf(q, r))) return r.redirect('/', 303);
    return html(r, page('dashboard', '<p>مرحبا</p>'));
  });
  app.get('/execution', async (q, r) => {
    if (!signedIn(sessionOf(q, r))) return r.redirect('/', 303);
    const find = (q.query as { n?: string }).n;
    const list = requests.filter((x) => !find || x.number === find);
    return html(r, page('execution', `<a href="/new">طلب جديد</a>
      <form method="get" action="/execution"><label for="n">رقم الطلب</label><input id="n" name="n"><button type="submit">بحث</button></form>
      <table>${list.map((x) => `<tr><td>${x.number}</td><td><a href="/request/${x.number}">عرض</a></td></tr>`).join('')}</table>`));
  });
  app.get('/new', async (q, r) => {
    const s = sessionOf(q, r);
    if (!signedIn(s)) return r.redirect('/', 303);
    s.fields = {};
    s.files = {};
    return html(r, page('new', '<a href="/form/1">تقديم طلب تنفيذ إلكتروني</a> <a href="#">المحكمة الافتراضية</a>'));
  });
  for (const n of [1, 2, 3, 4]) {
    app.get(`/form/${n}`, async (q, r) => {
      if (!signedIn(sessionOf(q, r))) return r.redirect('/', 303);
      return html(r, pages[`form${n}`]!());
    });
    app.post(`/form/${n}`, async (q, r) => {
      const s = sessionOf(q, r);
      await readForm(q, s);
      return r.redirect(n < 4 ? `/form/${n + 1}` : '/review', 303);
    });
  }
  app.get('/review', async (q, r) => {
    const s = sessionOf(q, r);
    if (!signedIn(s)) return r.redirect('/', 303);
    const f = s.fields;
    const rows: [string, string | undefined][] = [
      ['الرقم الموحد للمنشأة', f.unified], ['رقم الآيبان', opts.reviewIban ?? f.iban], ['رقم الهوية', f.id_number],
      ['المبلغ المدون في السند', `${Number(f.face_r ?? 0).toLocaleString('en-US')}.${f.face_h ?? '00'}`],
      ['المبلغ المتبقي', `${Number(f.remaining_r ?? 0).toLocaleString('en-US')}.${f.remaining_h ?? '00'}`],
      ['رقم السند', f.note_number], ['المحكمة', 'محكمة التنفيذ'],
    ];
    return html(r, page('review', steps(5) + `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v ?? '')}</dd>`).join('')}</dl>
      <form method="post" action="/send" enctype="multipart/form-data"><button type="submit">حفظ وإرسال</button></form>`));
  });
  app.post('/send', async (q, r) => {
    const s = sessionOf(q, r);
    await readForm(q, { fields: {}, files: {} });
    if (!signedIn(s)) return r.redirect('/', 303);
    if (opts.hangAfterSend) return html(r, page('sent', '<p>جاري المعالجة</p>'));
    const number = String(nextNumber++);
    requests.push({ number, fields: { ...s.fields, company: s.company! }, files: { ...s.files } });
    statuses.set(number, { status: 'قيد التنفيذ', circuit: 'دائرة التنفيذ الثالثة' });
    return html(r, page('sent', `<h2>تم تقديم الطلب بنجاح</h2><dl><dt>رقم الطلب</dt><dd>${number}</dd></dl>`));
  });
  app.get('/request/:n', async (q, r) => {
    if (!signedIn(sessionOf(q, r))) return r.redirect('/', 303);
    const st = statuses.get((q.params as { n: string }).n);
    if (!st) return r.code(404).send('not found');
    return html(r, page('request', `<dl><dt>حالة الطلب</dt><dd>${st.status}</dd><dt>الدائرة</dt><dd>${st.circuit}</dd></dl>`));
  });

  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url,
    requests,
    statuses,
    /** The owner chose the number in Nafath (for every sign-in from now on). */
    approve(on = true) {
      approveNafath = on;
    },
    set(o: FakeNajizOptions) {
      opts = o;
    },
    reset() {
      opts = {};
      approveNafath = false;
      sessions.clear();
    },
    close: () => app.close(),
  };
}
