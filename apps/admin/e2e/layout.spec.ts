import { expect, test } from '@playwright/test';

test.describe('admin layout smoke', () => {
  test('catalog open buttons share a fixed width', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();

    const buttons = page.locator('.ops-catalog-open-btn');
    await expect(buttons.first()).toBeVisible({ timeout: 15_000 });
    const count = await buttons.count();
    expect(count).toBeGreaterThan(1);

    const widths = await buttons.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().width)),
    );
    const unique = [...new Set(widths)];
    expect(
      unique,
      `button widths should match, got ${widths.join(', ')}`,
    ).toHaveLength(1);
    expect(unique[0]).toBeGreaterThanOrEqual(140);
  });

  test('chat and jobs without agentId show catalog empty state', async ({
    page,
  }) => {
    await page.goto('/chat');
    await expect(page.locator('.ops-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ops-split-layout')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
    await expect(page.getByText('Choose an agent')).toBeVisible();
    await expect(page.locator('#chat-agent-select')).toHaveCount(0);
    const chatBrowse = page.getByRole('link', { name: 'Browse catalog' });
    await expect(chatBrowse.first()).toBeVisible();
    await expect(chatBrowse.first()).toHaveAttribute(
      'href',
      '/catalog?mode=interactive',
    );

    await page.goto('/jobs');
    await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Choose an agent')).toBeVisible();
    await expect(page.locator('#jobs-agent-select')).toHaveCount(0);
    const jobsBrowse = page.getByRole('link', { name: 'Browse catalog' });
    await expect(jobsBrowse.first()).toHaveAttribute(
      'href',
      '/catalog?mode=autonomous',
    );
  });

  test('catalog mode query filters and opens into workspace with select', async ({
    page,
  }) => {
    await page.goto('/catalog?mode=interactive');
    await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Find agents here')).toBeVisible();

    const openChat = page.getByRole('button', { name: 'Open in Chat' }).first();
    await expect(openChat).toBeVisible({ timeout: 15_000 });
    await openChat.click();
    await expect(page).toHaveURL(/\/chat\/[^/]+/);
    await expect(page.locator('#chat-agent-select')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse catalog' })).toBeVisible();

    await page.goto('/catalog?mode=autonomous');
    const openJob = page.getByRole('button', { name: 'Run as Job' }).first();
    await expect(openJob).toBeVisible({ timeout: 15_000 });
    await openJob.click();
    await expect(page).toHaveURL(/\/jobs\/[^/]+/);
    await expect(page.locator('#jobs-agent-select')).toBeVisible();

    const jobsSelect = page.locator('#jobs-agent-select');
    const options = await jobsSelect.locator('option').all();
    if (options.length > 1) {
      const secondValue = await jobsSelect
        .locator('option')
        .nth(1)
        .getAttribute('value');
      await jobsSelect.selectOption(secondValue!);
      await expect(jobsSelect).toHaveValue(secondValue!);
    }
  });

  test('side nav labels Chat not Agent', async ({ page }) => {
    await page.goto('/catalog');
    await expect(
      page.locator('.ops-sidenav').getByRole('link', { name: 'Chat' }),
    ).toBeVisible();
    await expect(
      page.locator('.ops-sidenav').getByRole('link', { name: 'Agent' }),
    ).toHaveCount(0);
  });
});
