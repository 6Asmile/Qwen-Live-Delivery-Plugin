"""Exercise the simplified workbench against real local controls and a deterministic child."""
import json, os, subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
expect.set_options(timeout=15000)
root=Path(__file__).resolve().parent.parent; out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
child=subprocess.Popen(['node',str(root/'test/workbench-browser-host.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
ready=json.loads(child.stdout.readline()); errors=[]
def command(action):
 child.stdin.write(json.dumps({'action':action,'name':'simple-demo'})+'\n');child.stdin.flush();return json.loads(child.stdout.readline())
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
  guide_context=browser.new_context(viewport={'width':1440,'height':1000})
  guide=guide_context.new_page()
  attempts=[0]
  def reconnect(route):
   attempts[0]+=1
   if attempts[0]==1: route.fulfill(status=503,body='temporarily unavailable')
   else: route.continue_()
  guide.route('**/api/state*',reconnect)
  guide.goto(ready['entryUrl']);expect(guide.locator('#guide-hand')).to_be_visible()
  assert '/live-delivery/' in guide.url and '#access=' not in guide.url
  guide.click('#guide-skip');guide.reload();expect(guide.locator('#send-button')).to_be_enabled();expect(guide.locator('#guide-hand')).not_to_be_visible()
  fresh=guide_context.new_page();fresh.goto(ready['entryUrl']);expect(fresh.locator('#guide-hand')).to_be_visible()
  fresh.check('#guide-never');fresh.click('#guide-skip');fresh.reload();expect(fresh.locator('#send-button')).to_be_enabled();expect(fresh.locator('#guide-hand')).not_to_be_visible()
  fresh.click('#show-guide');expect(fresh.locator('#guide-hand')).to_be_visible();fresh.click('#guide-skip')
  guide.unroute_all(behavior="wait")
  guide_context.close()
  page=browser.new_page(viewport={'width':1440,'height':1000});page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(ready['entryUrl']);expect(page.locator('#guide-hand')).to_be_visible();assert page.locator('#guide-hand').evaluate('(e)=>getComputedStyle(e).animationName')=='point';page.check('#guide-never');page.click('#guide-skip')
  assert page.locator('#task-budget').count()==1
  for selector in ('#plan-form','#confirm-plan','#new-task-approval','#continue-approval','#add-plan','#save-plan','#version-select'):
   assert page.locator(selector).count()==0,selector
  page.click('#budget-button');page.fill('#task-budget','12');page.click('#save-budget');expect(page.locator('#budget-label')).to_contain_text('12 分')
  page.fill('#workspace-name','simple-demo');page.fill('#feedback','Build a useful interactive reference');page.locator('#feedback').press('Enter')
  expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text('simple-demo v1')
  first_run=page.locator('#run-select').input_value()
  def state():return page.request.get(ready['url'].rstrip('/')+'/api/state',params={'run':first_run}).json()
  assert state()['task']['planMode']=='rolling' and not state()['task']['awaitingPlanApproval']
  assert state()['task']['timeBudgetSec']==720
  expect(page.locator('#delivery-summary')).to_contain_text('已有 1 个可用版本')
  expect(page.locator('#versions [data-version="1"] .version-note')).to_have_text(state()['releases'][0]['note'])
  expect(page.locator('#version-overview')).to_be_visible()
  expect(page.locator('#release-note')).to_have_text(state()['releases'][0]['note'])
  assert '1/1' not in page.locator('#delivery-summary').inner_text()
  command('plan-next');expect(page.locator('#next-version .version-heading')).to_contain_text('V2')
  first_box=page.locator('#versions [data-version="1"]').bounding_box(); next_box=page.locator('#next-version').bounding_box()
  assert abs(first_box['y']-next_box['y'])<1 and abs(first_box['width']-next_box['width'])<1
  expect(page.locator('#next-label')).to_have_text('待交付目标')
  expect(page.locator('#next-spinner')).to_be_visible();assert page.locator('#next-spinner').evaluate('(e)=>getComputedStyle(e).animationName')=='spin'
  page.fill('#feedback','Next version: Use original illustrated diagrams and an accessible comparison.');page.locator('#feedback').press('Enter')
  expect(page.locator('#next-scope')).to_contain_text('original illustrated diagrams')
  expect(page.locator('.receipt').last).to_have_text('已读')
  assert len(state()['planRevisions'][-1]['feedbackIds'])==1
  page.click('#budget-button');page.fill('#task-budget','15');page.click('#save-budget');expect(page.locator('#budget-label')).to_contain_text('15 分');assert state()['task']['timeBudgetSec']==900
  page.evaluate("""() => {
    window.testFetch=window.fetch;
    window.fetch=(url,options)=>String(url).endsWith('/api/settings')
      ? new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))
      : window.testFetch(url,options);
  }""")
  page.click('#budget-button');page.fill('#task-budget','16');page.click('#save-budget')
  expect(page.locator('#budget-error')).to_contain_text('请求超时',timeout=20000);expect(page.locator('#save-budget')).to_be_enabled()
  assert state()['task']['timeBudgetSec']==900
  page.click('#close-budget');expect(page.locator('#feedback')).to_be_editable();page.evaluate('window.fetch=window.testFetch; delete window.testFetch')
  command('publish-next');expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text('simple-demo v2');assert state()['releases'][-1]['feedbackIds']
  page.locator('#versions [data-version="1"]').click();expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text('simple-demo v1')
  expect(page.locator('#release-note')).to_have_text(state()['releases'][0]['note'])
  page.locator('#artifact').content_frame.locator('#details').click();expect(page.locator('#artifact').content_frame.locator('#child')).to_have_text('Details');page.click('#preview-home');expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text('simple-demo v1')
  with page.expect_popup() as opened:page.click('#open-preview')
  expect(opened.value.locator('#case')).to_have_text('simple-demo v1');opened.value.close();page.reload();expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text('simple-demo v1')
  assert not page.locator('#release-details').evaluate('(e)=>e.open');page.locator('#release-files summary').click();page.fill('#file-filter','index.html');expect(page.locator('#file-list')).to_contain_text('index.html')
  assert not page.locator('#release-details').evaluate('(e)=>e.open');page.locator('#file-list [data-file="output/index.html"]').click();expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text('simple-demo v1')
  page.locator('#release-details summary').click();expect(page.locator('#check-list')).to_contain_text('Opens');page.locator('#release-details summary').click();page.locator('#release-files summary').click();page.locator('#versions [data-version="2"]').click()
  page.screenshot(path=str(out/'workbench-zh.png'),full_page=True)
  page.click('[data-lang=en]');assert page.evaluate('Array.from(QWEN_LD_I18N.missing)')==[];page.screenshot(path=str(out/'workbench-en.png'),full_page=True)
  for width in (1024,768,390,320):
   page.set_viewport_size({'width':width,'height':900});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
  page.set_viewport_size({'width':1440,'height':1000});page.click('#stop-button');expect(page.locator('#status-label')).to_have_text('Stopped');expect(page.locator('#send-label')).to_have_text('Continue execution')
  page.fill('#feedback','Continue with an original diagram');page.reload();expect(page.locator('#feedback')).to_have_value('Continue with an original diagram');page.click('#send-button')
  expect(page.locator('#versions [data-version="3"]')).to_be_visible()
  assert page.locator('#run-select').input_value()==first_run
  assert page.locator('#run-select option').count()==2
  assert page.locator('.round-link').count()==0
  expect(page.locator('#feed')).to_contain_text('Build a useful interactive reference')
  expect(page.locator('#feed')).to_contain_text('Continue with an original diagram')
  for version in (1,2,3):
   page.locator(f'#versions [data-version="{version}"]').click()
   expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text(f'simple-demo v{version}')
  page.locator('#versions [data-version="1"]').click();page.reload()
  expect(page.locator('#artifact').content_frame.locator('#case')).to_have_text('simple-demo v1')
  page.fill('#feedback','Keep the interaction from V1');page.locator('#feedback').press('Enter')
  expect(page.locator('.receipt').last).to_have_text('Read')
  assert state()['feedback'][-1]['version']==1
  command('plan-next');expect(page.locator('#next-version .version-heading')).to_contain_text('V4')
  page.fill('#feedback','A draft for the same task');page.reload()
  expect(page.locator('#feedback')).to_have_value('A draft for the same task')
  assert page.locator('#run-select').input_value()==first_run
  assert page.evaluate('Array.from(QWEN_LD_I18N.missing)')==[]
  page.click('#stop-button');expect(page.locator('#status-label')).to_have_text('Stopped');assert not errors,errors
  browser.close()
 print(json.dumps({'passed':True,'checks':['guide after reconnect, session skip, persistent opt-out and manual reopen','timeout restores editable controls','automatic first delivery','single budget editor','real chat revises next milestone','received feedback linked to publication','version navigation and reload','subpage home and independent preview','collapsed checks','bilingual and mobile UI','stop and continuation numbering'],'errors':errors}))
finally:
 try:command('quit');child.wait(timeout=5)
 except Exception:child.kill()
