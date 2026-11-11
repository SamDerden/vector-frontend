import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
const sizes = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920, 2560];
const failures = [];
await mkdir('test-results/responsive', { recursive: true });
const browser = await chromium.launch({ headless: true });
for (const width of sizes) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const response = await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
    if (!response?.ok()) failures.push(width + ': HTTP ' + response?.status());
    await page.screenshot({ path: 'test-results/responsive/home-' + width + '.png', fullPage: true });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.left < innerWidth + 100 && r.right > innerWidth + 3 &&
          st.position !== 'fixed' && st.position !== 'absolute';
      }).slice(0, 12).map(el => ({ tag: el.tagName, className: String(el.className).slice(0, 90) }))
    }));
    if (dimensions.scroll > dimensions.viewport + 3) failures.push(width + ': horizontal scroll ' + JSON.stringify(dimensions));
    if (errors.length) failures.push(width + ': JS errors ' + errors.join(' | '));
    const buttons = page.locator('button:visible');
    const count = await buttons.count();
    if (count === 0) failures.push(width + ': no visible buttons');
    // Click only safe UI navigation controls, never submit diagnostics or generate AI.
    const nav = page.getByRole('button', { name: /начать|выбрать класс|начать маршрут/i }).first();
    if (await nav.count()) {
      await nav.click({ timeout: 3000 }).catch(() => {});
      await page.screenshot({ path: 'test-results/responsive/after-navigation-' + width + '.png', fullPage: true });
    }
  } catch (error) {
    failures.push(width + ': ' + error.message);
  } finally {
    await page.close();
  }
}
await browser.close();
await writeFile('test-results/responsive/report.json', JSON.stringify({ sizes, failures }, null, 2));
console.log(JSON.stringify({ sizes, failures }, null, 2));
if (failures.length) process.exitCode = 1;
