// Proves the delegated dispatcher works with the CSP enforcing
// script-src-attr 'none'. If someone reintroduces an inline handler, or the
// dispatcher stops resolving actions, these fail rather than a clinician
// finding a dead button.

import { test, expect } from '@playwright/test';

test.describe('Action dispatcher under enforced CSP', () => {
  test('no inline event attributes survive in any app', async ({ page }) => {
    for (const url of ['/', '/patient.html', '/admin.html']) {
      await page.goto(url, { waitUntil: 'networkidle' });
      const inline = await page.evaluate(() =>
        [...document.querySelectorAll('*')]
          .filter(el => [...el.attributes].some(a => /^on[a-z]+$/.test(a.name)))
          .map(el => el.tagName.toLowerCase()));
      expect(inline, `${url} still has inline handlers on: ${inline.join(', ')}`).toEqual([]);
    }
  });

  test('dispatcher loads and reports no CSP violations', async ({ page }) => {
    const csp = [];
    page.on('console', m => {
      if (/Content Security Policy|Refused to execute/i.test(m.text())) csp.push(m.text());
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => !!window.__ocDispatch)).toBe(true);
    expect(csp, csp.join(' | ')).toEqual([]);
  });

  test('clicking a data-click control runs its action', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.click('button.ts-btn:has-text("Register")');
    await expect(page.locator('.ts-btn', { hasText: 'Register' })).toHaveClass(/active/);
    await page.click('button.ts-btn:has-text("Sign In")');
    await expect(page.locator('.ts-btn', { hasText: 'Sign In' })).toHaveClass(/active/);
  });

  test('parses string, numeric and element arguments', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const parsed = await page.evaluate(() => {
      const d = window.__ocDispatch;
      const el = document.createElement('button');
      return {
        str: d.parseArg("'hello'", el, null),
        dbl: d.parseArg('"hi"', el, null),
        num: d.parseArg('42', el, null),
        neg: d.parseArg('-1.5', el, null),
        bool: d.parseArg('true', el, null),
        nul: d.parseArg('null', el, null),
        self: d.parseArg('this', el, null) === el,
        json: d.parseArg('{"a":1}', el, null),
        stmts: d.splitStatements("a('x;y'); b()"),
        args: d.splitArgs("'a,b', 2, this"),
      };
    });
    expect(parsed.str).toBe('hello');
    expect(parsed.dbl).toBe('hi');
    expect(parsed.num).toBe(42);
    expect(parsed.neg).toBe(-1.5);
    expect(parsed.bool).toBe(true);
    expect(parsed.nul).toBe(null);
    expect(parsed.self).toBe(true);
    expect(parsed.json).toEqual({ a: 1 });
    // A semicolon inside a string must not split the statement.
    expect(parsed.stmts).toEqual(["a('x;y')", 'b()']);
    // Nor must a comma inside one split the arguments.
    expect(parsed.args).toEqual(["'a,b'", '2', 'this']);
  });

  test('an unknown action is reported, not silently ignored', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const reported = await page.evaluate(() => {
      window.__ocDispatchErrors = [];
      const b = document.createElement('button');
      b.setAttribute('data-click', 'definitelyNotAFunction()');
      document.body.appendChild(b);
      b.click();
      const errs = window.__ocDispatchErrors.slice();
      b.remove();
      return errs;
    });
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0].msg).toContain('definitelyNotAFunction');
  });

  test('controls that were dead now work', async ({ page }) => {
    const email = `disp_${Date.now()}@test.local`;
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(async (email) => {
      await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Dispatch Test', email, password: 'DispatchPass123' }),
      });
      await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ email, password: 'DispatchPass123' }),
      });
    }, email);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Lab Management had no goToLabsPanel() at all.
    await page.evaluate(() =>
      [...document.querySelectorAll('.nav-item')].find(b => /Lab Management/.test(b.textContent))?.click());
    await expect(page.locator('#panel-labs')).toHaveClass(/active/);

    // Why OncoConnect was trapped inside an IIFE.
    await page.evaluate(() =>
      [...document.querySelectorAll('.nav-item')].find(b => /Why OncoConnect/.test(b.textContent))?.click());
    await expect(page.locator('#about-modal')).toHaveCount(1);
  });
});
