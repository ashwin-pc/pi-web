import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, hashSecret, randomSecret } from '../../server/auth/kernel.js';
import { isolatedAuthEnv } from '../auth-isolation.js';

test('real authenticated STL extension derives true cube edges on demand, survives toggles, and reopens changed source',async({browser},info)=>{
 test.skip(info.project.name!=='desktop');test.setTimeout(90000);
 const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));const address=reservation.address();if(!address||typeof address==='string')throw Error('No port');const port=address.port,origin=`http://localhost:${port}`;await new Promise<void>(r=>reservation.close(()=>r()));
 const dir=await mkdtemp(join(tmpdir(),'pi-web-stl-real-edges-')),workspace=join(dir,'workspace'),home=join(dir,'home'),authPath=join(dir,'auth.json'),token=randomSecret();
 await mkdir(join(home,'extensions'),{recursive:true});await symlink(join(process.cwd(),'examples/pi-web-extensions/3d-modeling'),join(home,'extensions/3d-modeling'),'dir');await mkdir(join(workspace,'.pi/web/artifacts'),{recursive:true});
 const points=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],faces=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]],bytes=Buffer.alloc(84+faces.length*50);bytes.writeUInt32LE(faces.length,80);faces.forEach((face,i)=>face.flatMap(p=>points[p]).forEach((x,k)=>bytes.writeFloatLE(x,96+i*50+k*4)));const file=join(workspace,'.pi/web/artifacts/cube.stl');await writeFile(file,bytes);
 const seededId='01a1bd6d-6a86-771d-8269-9d31e911a96a';
 const sessionDir=join(dir,'agent','sessions',`--${workspace.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`);
 await mkdir(sessionDir,{recursive:true});
 await writeFile(join(sessionDir,'2026-11-08T00-00-00-000Z_'+seededId+'.jsonl'),[
  {type:'session',version:3,id:seededId,timestamp:new Date().toISOString(),cwd:workspace},
  {type:'message',id:'cube-owner',parentId:null,timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'text',text:'[cube.stl](/api/artifacts/cube.stl)'}],api:'openai-responses',provider:'openai',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}}
 ].map(x=>JSON.stringify(x)).join('\n')+'\n');
 await new AuthStore(authPath).update(s=>{s.config={policy:'authenticated',methods:[]};s.bootstrap={hash:hashSecret(token),expiresAt:Date.now()+120000};});
 const child=spawn(process.execPath,['--import','tsx','server.ts'],{cwd:process.cwd(),env:{...isolatedAuthEnv(),PI_WEB_HOME:home,PI_CODING_AGENT_DIR:join(dir,'agent'),PI_WEB_AUTH_STORE:authPath,PI_WEB_AUTH_POLICY:'authenticated',PI_WEB_AUTH_ORIGIN:origin,PI_WEB_CWD:workspace,PI_WEB_DEV:'0',NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),PI_WEB_SETTINGS_FILE:join(dir,'settings.json'),PI_WEB_SESSION_UI_STATE_FILE:join(dir,'sessions.json')},stdio:'ignore'});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 try{
  await expect.poll(()=>fetch(origin+'/api/state').then(r=>r.status).catch(()=>0)).toBe(401);const page=await context.newPage();let derivatives=0,fullSources=0;page.on('request',r=>{if(r.url().endsWith('/api/web-contributions/artifact-derived'))derivatives++;if(r.url().endsWith('/cube.stl')&&!r.headers().range)fullSources++;});
  await page.goto(origin+'/api/auth/bootstrap?token='+encodeURIComponent(token));await page.getByLabel('New password (12+ characters)').fill('real STL fixture password');await page.getByLabel('Confirm password').fill('real STL fixture password');await page.getByRole('button',{name:'Set password',exact:true}).click();await expect(page.locator('#prompt')).toBeVisible();
  await page.goto(origin+'/?sessionId='+seededId);
  const inline=page.locator('.artifactPreview').first(),inlineElement=inline.locator('iframe'),inlineFrame=inlineElement.contentFrame();
  await expect(inlineFrame.locator('#status')).toHaveText('Full detail · 12 triangles');
  const identity=await inlineElement.elementHandle();
  await inline.locator('.artifactPreviewShield').click();
  await inlineFrame.getByRole('checkbox',{name:'Feature outlines'}).check();
  await expect(inlineFrame.locator('#edge-status')).toHaveText('12 true feature edges · 35° source-face crease threshold');
  await expect(inlineFrame.getByRole('checkbox',{name:'Feature outlines'})).toBeChecked();
  await expect.poll(()=>identity!.evaluate(el=>el===document.querySelector('.artifactPreview iframe'))).toBe(true);
  expect(fullSources).toBe(1);expect(derivatives).toBe(1);
  const cameraSize=await inlineFrame.locator('canvas').boundingBox();
  await page.locator('#prompt').click();await page.getByRole('button',{name:'Sessions',exact:true}).click();await page.getByRole('button',{name:'Close sessions',exact:true}).click();
  await expect(inlineFrame.getByRole('checkbox',{name:'Feature outlines'})).toBeChecked();
  await expect.poll(async()=>Math.round((await inlineFrame.locator('canvas').boundingBox())!.width)).toBe(Math.round(cameraSize!.width));
  await page.locator('#prompt').fill('Preserve the earlier model');await page.locator('#promptForm').evaluate((form:HTMLFormElement)=>form.requestSubmit());
  await expect(page.locator('.message.user').filter({hasText:'Preserve the earlier model'})).toBeVisible();
  await expect.poll(()=>identity!.evaluate(el=>el===document.querySelector('.artifactPreview iframe'))).toBe(true);
  for(const width of [393,1440]){await page.setViewportSize({width,height:1000});await expect(inlineFrame.getByRole('checkbox',{name:'Feature outlines'})).toBeChecked();await page.screenshot({path:`.pi/web/artifacts/stl-feature-outlines/inline-${width}.png`});}
  await inline.locator('.artifactPreviewShield').click();await inlineFrame.getByRole('checkbox',{name:'Feature outlines'}).uncheck();await inlineFrame.getByRole('checkbox',{name:'Feature outlines'}).check();expect(fullSources).toBe(1);expect(derivatives).toBe(1);
  await page.getByRole('button',{name:'Open session actions'}).click();await page.getByRole('menuitem',{name:'File explorer'}).click();await page.getByRole('button',{name:'Artifacts',exact:true}).click();await page.getByRole('button',{name:'Preview cube.stl'}).click();
  const panel=page.locator('#artifactBrowserPreviewBody'),frame=panel.locator('iframe').contentFrame();await expect(frame.locator('#status')).toHaveText('Full detail · 12 triangles');expect(derivatives).toBe(1);expect(fullSources).toBe(2);
  const before=await frame.locator('canvas').screenshot();await frame.getByRole('checkbox',{name:'Feature outlines'}).check();await expect(frame.locator('#edge-status')).toHaveText('12 true feature edges · 35° source-face crease threshold');expect(derivatives).toBe(2);await expect(frame.locator('#info-count')).toHaveText('12 source triangles · 100% retained');expect(await frame.locator('canvas').screenshot()).not.toEqual(before);await page.screenshot({path:'.pi/web/artifacts/stl-feature-outlines/real-cube-desktop.png'});
  await frame.getByRole('checkbox',{name:'Feature outlines'}).uncheck();await frame.getByRole('checkbox',{name:'Feature outlines'}).check();expect(derivatives).toBe(2);expect(fullSources).toBe(2);
  for(const width of [320,393]){await page.setViewportSize({width,height:851});await page.screenshot({path:`.pi/web/artifacts/stl-feature-outlines/real-cube-mobile-${width}.png`});const bounds=await frame.locator('.controls').boundingBox();expect(bounds?.x).toBeGreaterThanOrEqual(0);expect((bounds?.x??0)+(bounds?.width??0)).toBeLessThanOrEqual(width+1);const rows=await frame.locator('.controls > button,.controls > details,.controls > label').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return r.y+r.height/2;}));expect(Math.max(...rows)-Math.min(...rows)).toBeLessThan(1);}
  await panel.getByRole('button',{name:'Unload model',exact:true}).click();await expect(panel.locator('iframe')).toHaveCount(0);bytes.writeFloatLE(2,96);await writeFile(file,bytes);await panel.getByRole('button',{name:'Open again',exact:true}).click();await expect(frame.locator('#status')).toHaveText('Full detail · 12 triangles');expect(fullSources).toBe(3);expect(derivatives).toBe(2);
  await frame.getByRole('checkbox',{name:'Feature outlines'}).check();await expect(frame.locator('#edge-status')).toHaveText(/^\d+ true feature edges · 35° source-face crease threshold$/);expect(derivatives).toBe(3);await expect(frame.locator('#status')).toHaveText('Full detail · 12 triangles');
 }finally{await context.close();child.kill();await new Promise<void>(r=>child.once('exit',()=>r()));await rm(dir,{recursive:true,force:true});}
});
