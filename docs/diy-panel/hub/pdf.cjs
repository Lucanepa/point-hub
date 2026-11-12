// Prints hub-level1.html to an A4 PDF at true size. PLAYWRIGHT=/path/to/node_modules/playwright node pdf.cjs
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ javaScriptEnabled: false, colorScheme: 'light' })).newPage();
  await p.goto('file://' + path.join(__dirname, 'hub-level1.html'), { waitUntil: 'load' });
  await p.pdf({ path: path.join(__dirname, 'hub-level1.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true, scale: 1 });
  await b.close();
})();
