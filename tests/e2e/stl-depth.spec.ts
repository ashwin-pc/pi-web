import { test, expect } from '@playwright/test';
import { stlContribution } from '../../examples/pi-web-extensions/3d-modeling/stl.js';

// Real GPU occlusion, not just matrix/projection string assertions. Two overlapping
// triangles have distinguishable flat normals; the +Z triangle must win LESS.
test('right-handed camera shows the near surface, independent of source order and up axis', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  const result = await stlContribution(() => '').render({ context: { name: 'depth.stl', path: '/api/artifacts/depth.stl' } });
  const html = result.html.replace('<script>', `<script>
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function(...args) {
      draw.apply(this, args);
      const pixel = new Uint8Array(4);
      this.readPixels(this.drawingBufferWidth/2|0,this.drawingBufferHeight/2|0,1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);
      window.centerPixel = Array.from(pixel);
    };
  `);
  for (const axis of ['y', 'z']) for (const reverse of [false, true]) {
    await page.setViewportSize({ width: 800, height: 650 });
    await page.setContent('<iframe style="width:780px;height:630px;border:0" sandbox="allow-scripts"></iframe>');
    await page.locator('iframe').evaluate((el: HTMLIFrameElement, html) => { el.srcdoc = html; }, html);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('canvas')).toBeVisible();
    const streamed = page.evaluate(async ({ axis, reverse }) => {
      // In Y-up scene coordinates: near normal (0,-1,2), far normal (0,0,1).
      let faces = [[-1,-1,1, 1,-1,1, 0,1,2], [-1,-1,-1, 1,-1,-1, 0,1,-1]];
      if (reverse) faces.reverse();
      if (axis === 'z') faces = faces.map(f => f.flatMap((_, i) => i % 3 ? [] : [f[i], -f[i+2], f[i+1]]));
      const bytes = new ArrayBuffer(184), data = new DataView(bytes); data.setUint32(80, 2, true);
      faces.forEach((f,i) => f.forEach((v,j) => data.setFloat32(84+i*50+12+j*4,v,true)));
      await new Promise<void>((resolve,reject) => {
        const channel = new MessageChannel(); const timer = setTimeout(() => reject(Error('handshake timeout')), 5000);
        channel.port1.onmessage = e => {
          if(e.data.type === 'ready') channel.port1.postMessage({type:'chunk',bytes},[bytes]);
          else if(e.data.type === 'ack') channel.port1.postMessage({type:'end'});
          else if(e.data.type === 'complete') { clearTimeout(timer); resolve(); }
          else if(e.data.type === 'error') reject(Error(e.data.error));
        };
        document.querySelector('iframe')!.contentWindow!.postMessage({type:'pi-artifact-stream',size:184},'*',[channel.port2]);
      });
    }, { axis, reverse });
    await frame.getByRole('button', { name: 'Load 3D preview', exact: true }).click();
    await streamed;
    await expect(frame.locator('#status')).toHaveText('Full detail · 2 triangles');
    await frame.locator('.info-menu summary').click();
    await frame.locator('#up-axis').selectOption(axis);
    await frame.locator('.info-menu summary').click();
    for (const view of ['front','back']) {
      await frame.locator('#view-menu summary').click(); await frame.locator(`[data-view="${view}"]`).click();
      await frame.locator('canvas').screenshot({ path: `.pi/web/artifacts/stl-depth-${axis}-${view}-${reverse ? 'reverse' : 'forward'}.png` });
      const pixel = await frame.locator('canvas').evaluate(() => (window as any).centerPixel as number[]);
      const normal = view === 'front' ? [0,-1,2] : [0,0,-1];
      const light = [.35,.55,.8];
      const d = Math.abs(normal.reduce((sum,v,i) => sum+v*light[i],0)) / Math.hypot(...normal) / Math.hypot(...light);
      const expected = Math.round(255*.68*(.58+.42*d));
      for (const channel of pixel.slice(0,3)) expect(Math.abs(channel-expected), `${axis} ${view} ${reverse}: ${pixel}`).toBeLessThanOrEqual(2);
      expect(pixel[3]).toBe(255);
    }
  }
});
