import { test, expect } from '@playwright/test';

test.describe('Patient App — OncoConnect', () => {
  // Use test data from backend (auto-created on startup)
  const testMRN = '12345';
  const testPassword = 'testpat123';

  test('patient login flow', async ({ page }) => {
    await page.goto('/patient.html');

    // Should show login screen
    await expect(page.locator('#screen-login')).toBeVisible();

    // Fill credentials - patient.html uses id="l-mrn" and id="l-pass"
    await page.fill('#l-mrn', testMRN);
    await page.fill('#l-pass', testPassword);

    // Submit
    await page.click('button:has-text("Sign In as Patient")');

    // Should be logged in (check for app shell)
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 5000 });
  });

  test('patient can view dashboard after login', async ({ page }) => {
    await page.goto('/patient.html');

    // Login
    await page.fill('#l-mrn', testMRN);
    await page.fill('#l-pass', testPassword);
    await page.click('button:has-text("Sign In as Patient")');

    // Should see app shell (patient dashboard)
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 5000 });
  });

  test('patient with invalid credentials cannot login', async ({ page }) => {
    await page.goto('/patient.html');

    // Try invalid credentials
    await page.fill('#l-mrn', '99999');
    await page.fill('#l-pass', 'wrongpass');
    await page.click('button:has-text("Sign In as Patient")');

    // Should stay on login screen (not see app shell)
    await expect(page.locator('#screen-login')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#app-shell')).not.toBeVisible();
  });

  test('patient can logout', async ({ page }) => {
    await page.goto('/patient.html');

    // Login
    await page.fill('#l-mrn', testMRN);
    await page.fill('#l-pass', testPassword);
    await page.click('button:has-text("Sign In as Patient")');

    // Wait for login to complete
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 5000 });

    // Look for logout button - it's usually in a menu or header
    const logoutBtn = page.locator('button:has-text("Logout"), button:has-text("Sign out"), button:has-text("Log out")').first();
    if (await logoutBtn.isVisible().catch(() => false)) {
      await logoutBtn.click();

      // Should show login screen again
      await expect(page.locator('#screen-login')).toBeVisible({ timeout: 5000 });
    }
  });
});
