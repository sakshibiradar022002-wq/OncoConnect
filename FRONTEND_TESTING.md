# Phase 4D: Frontend Integration Testing

## Overview

Playwright-based browser automation testing framework for validating the OncoConnect doctor and patient applications. Tests run against a real browser (Chromium) to verify end-to-end user flows.

## Setup

Install dependencies:
```bash
npm install --save-dev @playwright/test
```

## Running Tests

**Run all tests (headless):**
```bash
npm run test:ui
```

**Run tests with browser visible (debug mode):**
```bash
npm run test:ui:headed
```

**Run tests with step-by-step debugger:**
```bash
npm run test:ui:debug
```

**Run specific test file:**
```bash
npx playwright test tests/e2e/doctor.spec.js
npx playwright test tests/e2e/patient.spec.js
```

**Run specific test case:**
```bash
npx playwright test -g "patient login flow"
npx playwright test -g "doctor registration"
```

## Test Coverage

### Doctor App (tests/e2e/doctor.spec.js)
1. **Doctor registration flow** — Email, password, specialty registration
2. **Doctor login flow** — Email/password authentication
3. **Create test patient** — New patient record creation with MRN and password
4. **Patient selection** — Opening existing patient records
5. **Doctor can access patient records** — Verify dashboard access
6. **Patient data isolation** — Different doctors can't see each other's patients
7. **Doctor logout flow** — Session termination

### Patient App (tests/e2e/patient.spec.js)
1. **Patient login flow** — MRN and password authentication
2. **View dashboard after login** — Access patient home screen
3. **Invalid credentials rejected** — Failed login stays on login screen
4. **Patient logout flow** — Return to login screen after logout

## Test Results

Results are saved to `test-results/` including:
- `index.html` — Interactive HTML report
- `results.json` — Machine-readable results
- `junit.xml` — CI/CD integration format
- Screenshots/videos on failure

Open results in browser:
```bash
open test-results/index.html
```

## Configuration

**playwright.config.js** settings:
- **testDir**: `./tests/e2e`
- **fullyParallel**: `false` (single worker for vanilla JS app)
- **workers**: `1` — Ensure sequential test execution
- **baseURL**: `http://localhost:3000` (set via BASE_URL env var)
- **Screenshot/Video**: Captured on test failure for debugging
- **webServer**: Auto-starts `npm start` and waits for health check

## Selector Strategy

Tests use multiple selector strategies for reliability:
- **ID-based**: `#l-mrn`, `#app-shell` (most specific)
- **Text matching**: `button:has-text("Sign In")` (matches button content)
- **CSS class**: `.sidebar`, `.patient-nav` (UI state indicators)
- **Fallback locators**: Combined selectors with `.first()` for resilience

**Key element selectors:**
| Element | Selector |
|---------|----------|
| Patient MRN input | `#l-mrn` |
| Patient password input | `#l-pass` |
| Doctor email input | `input[type="email"]` |
| Doctor password input | `input[type="password"]` |
| Sign In button (doctor) | `button:has-text("Sign In")` |
| Sign In button (patient) | `button:has-text("Sign In as Patient")` |
| Register button | `button:has-text("Register")` |
| Sidebar (logged in indicator) | `.sidebar` |
| App shell | `#app-shell` |

## Failure Debugging

When a test fails:

1. **Check screenshot** — `test-results/` contains screenshot at failure point
2. **Watch video** — Review full interaction sequence in WebM format
3. **Read error message** — Playwright shows exact assertion and timeout
4. **Common issues:**
   - Button text mismatch (check HTML for actual button content)
   - Selector timing (element not yet rendered, increase timeout)
   - Server not running (check `npm start` is running on port 3000)

## CI/CD Integration

Add to GitHub Actions workflow:
```yaml
- name: Run frontend tests
  run: npm run test:ui
  
- name: Upload test results
  if: always()
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: test-results/
```

## Development Guidelines

**Writing new tests:**
```javascript
test('descriptive test name', async ({ page }) => {
  await page.goto('/patient.html');
  await page.fill('#l-mrn', '12345');
  await page.fill('#l-pass', 'password');
  await page.click('button:has-text("Sign In as Patient")');
  
  // Assertion
  await expect(page.locator('#app-shell')).toBeVisible({ timeout: 5000 });
});
```

**Best practices:**
- Use `page.goto()` for navigation (not manual URL entry)
- Use `page.waitForURL()` to wait for navigation
- Use timeouts (5000ms default) for UI visibility waits
- Fill forms before clicking submit (not during)
- Prefer ID selectors over complex CSS selectors
- Keep test descriptions in test("name", ...) sync with test content
- Close browser contexts manually after multi-context tests

## Playwright Best Practices

- Tests are NOT isolated by default; state persists between tests
- Use `page.goto('/patient.html')` to reset between test flows
- For true isolation, use separate browser contexts or restart server
- Playwright waits for elements to be actionable (visible, enabled, etc.)
- `expect()` automatically retries with timeout before failing

## References

- [Playwright Testing](https://playwright.dev/docs/intro)
- [Playwright Test Assertions](https://playwright.dev/docs/test-assertions)
- [Selectors](https://playwright.dev/docs/locators)
- [Configuration](https://playwright.dev/docs/test-configuration)

## Next Steps

- [ ] Integrate into CI/CD pipeline (.github/workflows/ci.yml)
- [ ] Add test data fixture setup (pre-create test accounts)
- [ ] Expand to cover error cases and edge conditions
- [ ] Add performance metrics collection during test runs
- [ ] Set up test result reporting to PRs
