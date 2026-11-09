import type { Mail } from './mailer.js';

/**
 * Login emails, Arabic first then English (the person's language is not
 * known before they log in). Plain words, no em dashes.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function linkEmail(opts: { to: string; name: string; link: string; kind: 'reset' | 'invite'; hours: number; company?: string }): Mail {
  const { to, name, link, kind, hours } = opts;
  const company = opts.company ?? '';
  const ar =
    kind === 'invite'
      ? {
          subject: 'دعوة إلى تالوس لمتابعة المديونيات',
          hello: `مرحباً ${name}،`,
          body: `تمت إضافتك إلى حساب ${company} في تالوس لمتابعة المديونيات. اضغط الزر لاختيار كلمة المرور والدخول.`,
          button: 'اختيار كلمة المرور',
          note: `ينتهي هذا الرابط بعد ${hours} ساعة ويعمل مرة واحدة فقط.`,
        }
      : {
          subject: 'إعادة تعيين كلمة المرور',
          hello: `مرحباً ${name}،`,
          body: 'طلبت إعادة تعيين كلمة المرور. اضغط الزر لاختيار كلمة مرور جديدة.',
          button: 'اختيار كلمة مرور جديدة',
          note: `ينتهي هذا الرابط بعد ${hours} ساعة ويعمل مرة واحدة فقط. إذا لم تطلب ذلك فتجاهل هذه الرسالة، وستبقى كلمة المرور كما هي.`,
        };
  const en =
    kind === 'invite'
      ? {
          subject: 'Your invitation to Talos debt follow-up',
          hello: `Hello ${name},`,
          body: `You have been added to ${company} on Talos debt follow-up. Choose your password to log in.`,
          button: 'Choose your password',
          note: `This link works once and ends in ${hours} hours.`,
        }
      : {
          subject: 'Reset your password',
          hello: `Hello ${name},`,
          body: 'You asked to reset your password. Choose a new one with the button below.',
          button: 'Choose a new password',
          note: `This link works once and ends in ${hours} hours. If you did not ask for this, ignore this email and your password stays the same.`,
        };

  const text = [ar.hello, ar.body, link, ar.note, '', '---', '', en.hello, en.body, link, en.note].join('\n');

  const block = (t: typeof ar, dir: 'rtl' | 'ltr', font: string) => `
    <div dir="${dir}" style="font-family:${font};text-align:${dir === 'rtl' ? 'right' : 'left'};color:#121B33;line-height:1.7">
      <p style="margin:0 0 8px;font-weight:600">${esc(t.hello)}</p>
      <p style="margin:0 0 20px">${esc(t.body)}</p>
      <p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#0E9F6E;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">${esc(t.button)}</a></p>
      <p style="margin:0;color:#47516B;font-size:13px">${esc(t.note)}</p>
    </div>`;

  const html = `<!doctype html><html><body style="margin:0;background:#F2F4F8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E2E6EE">
    <div style="background:#121B33;color:#ffffff;padding:20px 28px;font-family:Arial,sans-serif;font-weight:700;letter-spacing:1px">TALOS</div>
    <div style="padding:28px">
      ${block(ar, 'rtl', "'IBM Plex Sans Arabic',Tahoma,Arial,sans-serif")}
      <hr style="border:0;border-top:1px solid #E2E6EE;margin:28px 0">
      ${block(en, 'ltr', "'IBM Plex Sans',Arial,sans-serif")}
    </div>
  </div></body></html>`;

  return { to, subject: `${ar.subject} | ${en.subject}`, text, html };
}
