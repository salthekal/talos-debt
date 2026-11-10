/**
 * Turning a web page into a PDF with a real browser (Chromium through
 * Playwright). Arabic needs proper letter joining and right to left text,
 * which the browser does well and plain PDF libraries do not.
 *
 * The page is given as HTML with everything inside it (fonts as data URLs),
 * and the browser is not allowed to load anything from the network.
 */
import { chromium, type Browser } from 'playwright';

export interface PdfRenderer {
  htmlToPdf(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

export class ChromiumPdfRenderer implements PdfRenderer {
  private browser: Promise<Browser> | null = null;

  private start(): Promise<Browser> {
    if (!this.browser) {
      this.browser = chromium.launch({ args: ['--disable-dev-shm-usage'] }).catch((err) => {
        this.browser = null;
        throw err;
      });
    }
    return this.browser;
  }

  async htmlToPdf(html: string): Promise<Buffer> {
    const browser = await this.start();
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    try {
      const page = await context.newPage();
      // Nothing leaves the server: every request the page makes is refused.
      await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      return Buffer.from(pdf);
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b).close().catch(() => undefined);
  }
}
