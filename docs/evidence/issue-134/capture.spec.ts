import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const out = process.env.ISSUE_134_OUTPUT!;
test('settled launcher evidence', async ({page}) => {
 await page.goto('/');
 await page.addStyleTag({content: '.actionLauncherItem { font: 700 16px Georgia, serif; }'});
 await page.locator('.actionLauncherToggle').click();
 const menu = page.locator('.actionLauncherMenu');
 await menu.getByRole('menuitem').first().evaluate(async item => {
  await Promise.all(Array.from(item.parentElement!.querySelectorAll('button'), button => Promise.all(button.getAnimations().map(a => a.finished))));
 });
 const widths = await menu.getByRole('menuitem').evaluateAll(items => items.map(item => ({label:item.textContent?.trim(), width:item.getBoundingClientRect().width})));
 writeFileSync(out + '.json', JSON.stringify(widths, null, 2));
 await page.screenshot({path:out + '.png', clip:{x:790,y:290,width:480,height:490}});
});
