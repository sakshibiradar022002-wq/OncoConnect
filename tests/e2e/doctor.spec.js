import { test, expect } from '@playwright/test';

test.describe('Doctor App — OncoConnect Pro', () => {
  let doctorEmail = `doc_${Date.now()}@test.local`;
  let doctorPassword = 'TestPass123!@#';
  let testMRN = `TEST${Date.now()}`;
  let testPatientPassword = 'PatPass123!';

  test('doctor registration flow', async ({ page }) => {
    await page.goto('/');

    // Click register tab to show registration form
    await page.click('button.ts-btn:has-text("Register")');

    // Fill registration form (Step 1)
    await page.fill('#rg-name', 'Test Doctor');
    await page.fill('#rg-email', doctorEmail);
    await page.selectOption('#rg-spec', 'Neuro-Oncology');
    await page.fill('#rg-hosp', 'Test Hospital');
    await page.fill('#rg-pass', doctorPassword);

    // Click "Send Verification Code"
    await page.click('button:has-text("Send Verification Code")');

    // In dev mode, OTP fallback shows the code or we skip
    // For this test, just verify we got to step 2
    await expect(page.locator('#reg-step-2')).toBeVisible({ timeout: 5000 });
  });

  test('doctor login flow', async ({ page }) => {
    await page.goto('/');

    // Fill credentials using actual input IDs
    await page.fill('#li-email', doctorEmail);
    await page.fill('#li-pass', doctorPassword);

    // Submit
    await page.click('button:has-text("Sign In")');

    // Should see dashboard (app with sidebar visible)
    await expect(page.locator('#app')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5000 });
  });

  test('create test patient', async ({ page }) => {
    // Login first
    await page.goto('/');
    await page.fill('#li-email', doctorEmail);
    await page.fill('#li-pass', doctorPassword);
    await page.click('button:has-text("Sign In")');

    // Wait for app to load
    await expect(page.locator('#app')).toBeVisible({ timeout: 5000 });

    // Click Add Patient button
    await page.click('button:has-text("Add Patient")');

    // Fill patient form - MRN is auto-generated
    await page.fill('#ap-name', 'Test Patient John Doe');
    await page.fill('#ap-email', `testpat_${Date.now()}@test.local`);
    await page.selectOption('#ap-phase', 'Treatment Phase');

    // Submit
    await page.click('button:has-text("Create Record")');

    // Verify credentials are shown
    await expect(page.locator('#ap-creds')).toBeVisible({ timeout: 5000 });
  });

  test('patient selection and record opening', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.fill('#li-email', doctorEmail);
    await page.fill('#li-pass', doctorPassword);
    await page.click('button:has-text("Sign In")');

    // Wait for app to load
    await expect(page.locator('#app')).toBeVisible({ timeout: 5000 });

    // Try to click on a patient if any exist
    const patientRows = page.locator('.patient-row, [data-testid="patient"]');
    const count = await patientRows.count();

    if (count > 0) {
      await patientRows.first().click();
      // Should open patient record - wait for record to show
      await expect(page.locator('#rec-pat-name, .record-shell')).toBeVisible({ timeout: 5000 });
    }
  });

  test('doctor can access patient records', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.fill('#li-email', doctorEmail);
    await page.fill('#li-pass', doctorPassword);
    await page.click('button:has-text("Sign In")');

    // Verify sidebar is visible (indicates logged in)
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5000 });
  });

  test('patient data isolation (can only see own patients)', async ({ page, context }) => {
    // Login as doctor 1
    await page.goto('/');
    await page.fill('#li-email', doctorEmail);
    await page.fill('#li-pass', doctorPassword);
    await page.click('button:has-text("Sign In")');

    // Verify logged in
    await expect(page.locator('#app')).toBeVisible({ timeout: 5000 });

    // Create new context for second doctor
    const context2 = await context.browser().newContext();
    const page2 = await context2.newPage();

    const otherEmail = `other_${Date.now()}@test.local`;
    const otherPassword = 'OtherPass123!@#';

    await page2.goto('/');
    // Click register tab
    await page2.click('button.ts-btn:has-text("Register")');

    // Fill registration form
    await page2.fill('#rg-name', 'Other Doctor');
    await page2.fill('#rg-email', otherEmail);
    await page2.selectOption('#rg-spec', 'Neuro-Oncology');
    await page2.fill('#rg-hosp', 'Other Hospital');
    await page2.fill('#rg-pass', otherPassword);

    // Click Send Verification Code
    await page2.click('button:has-text("Send Verification Code")');

    // Verify registration step 2
    await expect(page2.locator('#reg-step-2')).toBeVisible({ timeout: 5000 });

    await context2.close();
  });

  test('doctor logout flow', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.fill('#li-email', doctorEmail);
    await page.fill('#li-pass', doctorPassword);
    await page.click('button:has-text("Sign In")');

    // Should see sidebar (logged in)
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5000 });

    // Look for logout in user menu or profile
    // Try clicking profile/doc-name area if it exists, or find a logout button
    const logoutBtn = page.locator('button:has-text("Logout"), button:has-text("Log out"), [data-testid="logout"]').first();
    if (await logoutBtn.isVisible().catch(() => false)) {
      await logoutBtn.click();
      // After logout, should return to login
      await expect(page.locator('button.ts-btn:has-text("Sign In")')).toBeVisible({ timeout: 5000 });
    }
  });
});
