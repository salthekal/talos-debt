import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends email. Tests use a fake that keeps the messages. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Development: writes each email to api/.data/mail so the reset link can be opened by hand. */
export class LogMailer implements Mailer {
  constructor(private readonly dir: string) {}
  async send(mail: Mail): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${mail.to.replace(/[^a-z0-9@.]/gi, '_')}.txt`);
    await writeFile(file, `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`, 'utf8');
    console.info(`[mail] ${mail.subject} -> ${mail.to} (saved to ${file})`);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(url: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

export function createMailer(config: Config): Mailer {
  return config.MAIL_DRIVER === 'smtp'
    ? new SmtpMailer(config.SMTP_URL!, config.MAIL_FROM)
    : new LogMailer(join(config.STORAGE_LOCAL_DIR, '..', 'mail'));
}
