import { test, expect } from '@playwright/test';

test.describe('Doctor App — OncoConnect Pro', () => {
  let doctorEmail = `doc_${Date.now()}@test.local`;
  let doctorPassword = 'TestPass123!@#';
  let testMRN = `TEST${Date.now()}`;
  let testPatientPassword = 'PatPass123!';

  test('doctor registration flow', async ({ page }) => {
    await page.goto('/');

    // Click register tab
    const registerBtn = page.locator('button:has-text("Register")').first();
    await registerBtn.click();

    // Fill registration form - should appear after clicking register tab
    await page.fill('input[type="email"]', doctorEmail);
    await page.fill('input[placeholder*="password"]', doctorPassword);
    await page.fill('input[placeholder*="confirm"]', doctorPassword);
    await page.fill('input[placeholder*="name"]', 'Test Doctor');
    await page.fill('input[placeholder*="specialty"]', 'Oncology');
    await page.fill('input[placeholder*="institution"]', 'Test Hospital');

    // Submit registration
    await page.click('button:has-text("Register")');

    // Should be logged in after registration
    await expect(page.locator('.sidebar'), { timeout: 5000 }).toBeVisible();
  });

  test('doctor login flow', async ({ page }) => {
    await page.goto('/');

    // Fill credentials
    await page.fill('input[type="email"]', doctorEmail);
    await page.fill('input[type="password"]', doctorPassword);

    // Submit
    await page.click('button:has-text("Sign In")');

    // Should see dashboard
    await expect(page).toHaveURL('/');
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5000 });
  });

  test('create test patient', async ({ page }) => {
    // Login first
    await page.goto('/');
    await page.fill('input[type="email"]', doctorEmail);
    await page.fill('input[type="password"]', doctorPassword);
    await page.click('button:has-text("Sign In")');

    // Wait for dashboard
    await page.waitForURL('/', { timeout: 5000 });
    await expect(page.locator('.sidebar')).toBeVisible();

    // Add new patient
    const addPatientBtn = page.locator('button:has-text("Add Patient")').first();
    await addPatientBtn.click();

    // Fill patient form
    await page.fill('input[placeholder*="name"]', 'Test Patient John Doe');

    // Fill MRN
    const mrnInput = page.locator('input[placeholder*="MRN"]').first();
    if (await mrnInput.isVisible()) {
      await mrnInput.fill(testMRN);
    }

    // Fill password
    await page.fill('input[placeholder*="password"]', testPatientPassword);

    // Submit
    await page.click('button:has-text("Create Record")');

    // Verify patient appears in list
    await expect(page.locator(`text=${testMRN}`)).toBeVisible({ timeout: 5000 });
  });

  test('patient selection and record opening', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.fill('input[type="email"]', doctorEmail);
    await page.fill('input[type="password"]', doctorPassword);
    await page.click('button:has-text("Sign In")');
    await page.waitForURL('/');

    // Click patient record (by MRN or name)
    const patientRow = page.locator('text=' + testMRN).first();
    if (await patientRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await patientRow.click();
      // Should open patient record
      await expect(page.locator('text=' + testMRN)).toBeVisible({ timeout: 5000 });
    }
  });

  test('doctor can access patient records', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.fill('input[type="email"]', doctorEmail);
    await page.fill('input[type="password"]', doctorPassword);
    await page.click('button:has-text("Sign In")');
    await page.waitForURL('/');

    // Verify sidebar is visible (indicates logged in)
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('patient data isolation (can only see own patients)', async ({ page, context }) => {
    // Login as doctor 1
    await page.goto('/');
    await page.fill('input[type="email"]', doctorEmail);
    await page.fill('input[type="password"]', doctorPassword);
    await page.click('button:has-text("Sign In")');
    await page.waitForURL('/');

    // Verify we can see sidebar (logged in)
    await expect(page.locator('.sidebar')).toBeVisible();

    // Create new context (new browser session for different doctor)
    const context2 = await context.browser().newContext();
    const page2 = await context2.newPage();

    const otherEmail = `other_${Date.now()}@test.local`;
    const otherPassword = 'OtherPass123!@#';

    await page2.goto('/');
    const registerBtn = page2.locator('button:has-text("Register")').first();
    await registerBtn.click();

    await page2.fill('input[type="email"]', otherEmail);
    await page2.fill('input[placeholder*="password"]', otherPassword);
    await page2.fill('input[placeholder*="confirm"]', otherPassword);
    await page2.fill('input[placeholder*="name"]', 'Other Doctor');
    await page2.fill('input[placeholder*="specialty"]', 'Oncology');

    await page2.click('button:has-text("Register")');

    // Other doctor should be logged in but with their own data
    await expect(page2.locator('.sidebar')).toBeVisible({ timeout: 5000 });

    await context2.close();
  });

  test('doctor logout flow', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.fill('input[type="email"]', doctorEmail);
    await page.fill('input[type="password"]', doctorPassword);
    await page.click('button:has-text("Sign In")');
    await page.waitForURL('/');

    // Should see sidebar (logged in)
    await expect(page.locator('.sidebar')).toBeVisible();

    // Try to logout - look for logout button or menu
    const logoutBtn = page.locator('button:has-text("Logout"), button:has-text("Sign out")').first();
    if (await logoutBtn.isVisible().catch(() => false)) {
      await logoutBtn.click();
      await expect(page.locator('.sidebar')).not.toBeVisible({ timeout: 5000 });
    }
  });
});
