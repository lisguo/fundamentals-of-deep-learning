// SPDX-License-Identifier: Apache-2.0
// Run against the local pilot server. AUTH_URL_FILE contains a private Jupyter login URL.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const login = (await fs.readFile(process.env.AUTH_URL_FILE, 'utf8')).trim();
const live = process.env.LIVE_ACTIVITY === '1';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const writes = [];
const responses = [];
let progress = 0;
let completedAt = null;
let sessions = 0;
let failCompletion = false;
const sessionId = '019f0000-0000-7000-8000-000000000001';
const state = () => ({session_id: sessionId, tracking_mode:'anonymous', progress_percent: progress, completed_at: completedAt});
const config = JSON.parse(await fs.readFile(new URL('../../activity-config.local.json', import.meta.url), 'utf8'));
if (!live) {
  await page.route(`${config.baseUrl}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    let response;
    let status = 200;
    if (url.pathname === '/v1/activity-sessions') {
      sessions++;
      response = { session_id: sessionId, session_token:'test-token-not-a-real-credential', expires_at:new Date(Date.now()+86400000).toISOString() };
    } else if (url.pathname.endsWith('/state')) {
      response = state();
    } else if (url.pathname.endsWith('/updates')) {
      writes.push({type:body.type,key:request.headers()['idempotency-key']});
      if (body.type === 'completed' && failCompletion) { status = 503; response = {detail:'test outage'}; }
      else {
        if (body.type === 'progress') progress = body.payload.progress_percent;
        if (body.type === 'completed') completedAt = new Date().toISOString();
        response = {update_id: crypto.randomUUID(),received_at: new Date().toISOString(),state:state()};
        status = 201;
      }
    } else { throw new Error(`Unexpected API path: ${url.pathname}`); }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(response)});
  });
} else {
  page.on('response', async response => {
    if (!response.url().startsWith(config.baseUrl)) return;
    const request = response.request();
    const entry = {method: request.method(),path:new URL(response.url()).pathname,status:response.status()};
    if (request.method() === 'POST' && entry.path.endsWith('/updates')) entry.body = request.postDataJSON();
    try {
      const data = await response.json();
      // Allowlist only public identifiers and state, never session tokens.
      entry.result = Object.fromEntries(['session_id','update_id','progress_percent','completed_at','state'].filter(k=>k in data).map(k=>[k,data[k]]));
    } catch (_) {}
    responses.push(entry);
  });
}
try {
  // Isolate tests from notebooks restored in the learner's default workspace.
  const testUrl = new URL(login);
  testUrl.pathname = `/lab/workspaces/activity-test-${crypto.randomUUID()}`;
  await page.goto(testUrl.href, {waitUntil:'domcontentloaded'});
  await page.locator('#fdl-activity-panel').waitFor({state:'attached',timeout:60000});
  assert.equal(sessions, 0, 'launcher alone must not start tracking');
  testUrl.search = '';
  testUrl.pathname += '/tree/tutorials/00_jupyterlab.ipynb';
  await page.goto(testUrl.href, {waitUntil:'domcontentloaded'});
  const panel = page.locator('#fdl-activity-panel');
  await panel.getByText('Course started. Activity session recorded.',{exact:true}).waitFor({timeout:45000});
  if (!live) {
    assert.equal(sessions,1);
    failCompletion = true;
    await panel.getByRole('button',{name:'Mark course complete',exact:true}).click();
    await panel.getByText('Activity could not be confirmed.',{exact:false}).waitFor({timeout:30000});
    assert.equal(completedAt,null);
    failCompletion = false;
    await panel.getByRole('button',{name:'Retry',exact:true}).click();
  } else {
    await panel.getByRole('button',{name:'Mark course complete',exact:true}).click();
  }
  await panel.getByText('Self-reported completion recorded.',{exact:true}).waitFor({timeout:45000});
  assert.equal(await panel.getByRole('button',{name:'Mark course complete',exact:true}).isDisabled(), true);
  if (!live) {
    assert.equal(sessions,1);
    assert.equal(progress,100);
    assert.ok(completedAt);
    assert.ok(writes.filter(x=>x.type==='completed').every(x=>x.key==='fdl:self-reported:completed'));
  }
  // The activity token must not be persisted by the extension.
  const storage = await page.evaluate(() => [...Object.entries(localStorage),...Object.entries(sessionStorage)]);
  assert.ok(storage.every(([k,v]) => !/session_token|test-token-not-a-real-credential/.test(k+v)));
  if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
  console.log(JSON.stringify({mode:live?'live-api':'intercepted-api',result:'PASS',sessions:live?undefined:sessions,writes:live?undefined:writes,responses:live?responses:undefined},null,2));
} catch(error) {
  console.error('Browser test failed:', error.message.split('\n')[0]);
  console.error('Panel:', await page.locator('#fdl-activity-panel').textContent().catch(()=> 'not loaded'));
  if (live) console.error(JSON.stringify(responses,null,2));
  if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
  process.exitCode=1;
} finally { await browser.close(); }
