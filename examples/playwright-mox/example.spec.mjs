import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

test.beforeAll(() => {
  execSync('mox set-scenario e2e-happy', { stdio: 'inherit' });
});

test.afterAll(() => {
  execSync('mox set-scenario e2e-happy', { stdio: 'inherit' });
});

test('smoke: open local page via bypass (replace with your app URL)', async ({ page }) => {
  // Local page must bypass the proxy (see playwright.config.mjs bypass list).
  const startUrl = process.env.MOX_START_URL || 'http://127.0.0.1:8000';
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/127\.0\.0\.1|localhost/);
});
