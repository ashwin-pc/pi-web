import { test, expect } from '@playwright/test';
import { stlContribution } from '../../examples/pi-web-extensions/3d-modeling/stl.js';

test('original Y-up ground and grid disappear from the bottom without changing source triangles', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  let html = (await stlContribution(() => '').render({ context: { name: 'tetrahedron.stl', path: '/api/artifacts/tetrahedron.stl' } })).html;
  html=html.replace('<script>',`<script>window.sceneMatrices=[];window.scenePan=[0,0];const originalPan=WebGL2RenderingContext.prototype.uniform2fv;WebGL2RenderingContext.prototype.uniform2fv=function(location,value){window.scenePan=Array.from(value);return originalPan.call(this,location,value);};const originalMatrix=WebGL2RenderingContext.prototype.uniformMatrix3fv;WebGL2RenderingContext.prototype.uniformMatrix3fv=function(location,transpose,value){window.sceneMatrices.push(Array.from(value));return originalMatrix.call(this,location,transpose,value);};`);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.setContent('<iframe style="border:0;width:880px;height:680px" sandbox="allow-scripts"></iframe>');
  await page.locator('iframe').evaluate((el: HTMLIFrameElement, html) => { el.srcdoc = html; }, html);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('canvas')).toBeVisible();
  await page.evaluate(async () => {
    const bytes = new ArrayBuffer(284), data = new DataView(bytes); data.setUint32(80, 4, true);
    const faces = [[0,0,0,1,0,0,0,1,0],[0,0,0,0,0,1,1,0,0],[0,0,0,0,1,0,0,0,1],[1,0,0,0,0,1,0,1,0]];
    faces.forEach((f,i) => f.forEach((v,j) => data.setFloat32(84+i*50+12+j*4,v,true)));
    await new Promise<void>((resolve,reject) => {
      const channel = new MessageChannel(); setTimeout(() => reject(Error('Stream handshake timed out')), 5000);
      channel.port1.onmessage = e => { if(e.data.type==='ready') channel.port1.postMessage({type:'chunk',bytes},[bytes]); else if(e.data.type==='ack') channel.port1.postMessage({type:'end'}); else if(e.data.type==='complete') resolve(); else if(e.data.type==='error') reject(Error(e.data.error)); };
      document.querySelector('iframe')!.contentWindow!.postMessage({type:'pi-artifact-stream',size:284},'*',[channel.port2]);
    });
  });
  const canvas = frame.locator('canvas');
  await expect(frame.locator('#status')).toHaveText('Full detail · 4 triangles');
  await canvas.screenshot({path:'.pi/web/artifacts/stl-ground-isometric.png'});
  const cdp=await page.context().newCDPSession(page);
  const pull=async(x:number,from:number,to:number)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:from}]});for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:from+(to-from)*i/5}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  for (const axis of ['y','z']) {
    await frame.locator('.info-menu summary').click();
    await frame.locator('#up-axis').selectOption(axis);
    await frame.locator('.info-menu summary').click();
    for (const view of ['top','bottom']) {
      await frame.locator('#view-menu summary').click(); await frame.locator(`[data-view="${view}"]`).click();
      await canvas.screenshot({path:`.pi/web/artifacts/stl-${axis}-up-${view}.png`});
      const withGround = await page.screenshot({clip:{x:150,y:150,width:500,height:350}});
      await frame.locator('.info-menu summary').click(); await frame.locator('#ground').uncheck(); await frame.locator('.info-menu summary').click();
      const withoutGround = await page.screenshot({clip:{x:150,y:150,width:500,height:350}});
      expect(withGround.equals(withoutGround),`${axis}-up ${view} actual ground pixels`).toBe(view==='bottom');
      await frame.locator('.info-menu summary').click(); await frame.locator('#ground').check(); await frame.locator('.info-menu summary').click();
      await expect(frame.locator('#info-count')).toHaveText('4 source triangles · 100% retained');
    }
    await frame.locator('#view-menu summary').click();await frame.locator('[data-view="front"]').click();
    const landmark=axis==='z'?[-.5,.5,-.5]:[-.5,-.5,-.5];
    const projectedY=()=>canvas.evaluate((_el,v:number[])=>{const r=(window as any).sceneMatrices.at(-3);return -(r[1]*v[0]+r[4]*v[1]+r[7]*v[2]);},landmark);
    const box=await canvas.boundingBox();if(!box)throw Error('canvas missing');
    const x=box.x+box.width*.5,y=box.y+box.height*.5;
    await canvas.screenshot({path:`.pi/web/artifacts/stl-${axis}-up-drag-before.png`});
    const projected=()=>canvas.evaluate((_el,v:number[])=>{const r=(window as any).sceneMatrices.at(-3),p=(window as any).scenePan;return [(r[0]*v[0]+r[3]*v[1]+r[6]*v[2]) + p[0],-(r[1]*v[0]+r[4]*v[1]+r[7]*v[2])-p[1]];},landmark);
    const drag=async(dx:number,dy:number,button:'left'|'right'='left',shift=false)=>{await page.mouse.move(x,y);if(shift)await page.keyboard.down('Shift');await page.mouse.down({button});await page.mouse.move(x+dx,y+dy,{steps:5});await page.mouse.up({button});if(shift)await page.keyboard.up('Shift');await canvas.screenshot();};
    const start=await projected();await drag(30,0);const right=await projected();expect(right[0],`${axis} actual source landmark follows right mouse orbit`).toBeGreaterThan(start[0]);await drag(-30,0);
    await drag(0,30);const mouseDown=await projected();expect(mouseDown[1],`${axis} actual source landmark follows down mouse orbit`).toBeGreaterThan(start[1]);await drag(0,-30);
    for(const mode of ['right','shift'] as const){const before=await projected();await drag(30,20,mode==='right'?'right':'left',mode==='shift');const after=await projected();expect(after[0],`${mode} pan right`).toBeGreaterThan(before[0]);expect(after[1],`${mode} pan down`).toBeGreaterThan(before[1]);await drag(-30,-20,mode==='right'?'right':'left',mode==='shift');}
    const touchStart=await projected();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let n=1;n<=5;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+30*n/5,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await canvas.screenshot();
    expect((await projected())[0],`${axis} source landmark follows right touch orbit`).toBeGreaterThan(touchStart[0]);
    await drag(-30,0);
    const twoStart=await projected();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:x-45,y},{id:2,x:x+45,y}]});
    for(let n=1;n<=5;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:x-45+30*n/5,y:y+20*n/5},{id:2,x:x+45+30*n/5,y:y+20*n/5}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await canvas.screenshot();
    const twoEnd=await projected();expect(twoEnd[0],`${axis} two-finger source pan right`).toBeGreaterThan(twoStart[0]);expect(twoEnd[1],`${axis} two-finger source pan down`).toBeGreaterThan(twoStart[1]);
    await drag(-30,-20,'right');
    const initial=await projectedY();
    await pull(x,y,y+40);
    await canvas.screenshot({path:`.pi/web/artifacts/stl-${axis}-up-drag-down.png`});
    const down=await projectedY();expect(down,`${axis} frontmost landmark follows downward pull`).toBeGreaterThan(initial);
    await pull(x,y+40,y);
    await canvas.screenshot({path:`.pi/web/artifacts/stl-${axis}-up-drag-up.png`});
    expect(await projectedY()).toBeCloseTo(initial,5);
  }
});
