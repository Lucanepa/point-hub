// Prints build-manual.html to an A4 PDF. Needs Playwright: PLAYWRIGHT=/path/to/node_modules/playwright node pdf.cjs
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ javaScriptEnabled: false, colorScheme: 'light' });
  const p = await c.newPage();
  await p.goto('file://' + path.join(__dirname, 'build-manual.html'), { waitUntil: 'networkidle' });
  await p.pdf({ path: path.join(__dirname, 'point-hub-build-manual.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>', footerTemplate: '<div style="font:8px sans-serif;width:100%;text-align:center;color:#666">Point Hub board · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  await b.close();
})();
