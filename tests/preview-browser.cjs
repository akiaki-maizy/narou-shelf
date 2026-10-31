const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const http=require("node:http");
const {chromium}=require("playwright");
const ROOT=path.resolve(__dirname,"..");
const PREFIX="/narou-shelf/preview/v7.3/";
const FILES=new Set(["index.html","sw.js","manifest.webmanifest"]);
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,"http://localhost").pathname;
  if(!pathname.startsWith(PREFIX)){res.writeHead(404);return res.end("Not found")}
  const name=pathname.substring(PREFIX.length)||"index.html";
  if(!FILES.has(name)){res.writeHead(404);return res.end("Not found")}
  const ext=path.extname(name);
  const type=ext===".js"?"text/javascript":ext===".webmanifest"?"application/manifest+json":"text/html";
  res.writeHead(200,{"Content-Type":type+"; charset=utf-8","Cache-Control":"no-store"});
  fs.createReadStream(path.join(ROOT,"preview/v7.3",name)).pipe(res);
});
async function main(){
  const html=fs.readFileSync(path.join(ROOT,"preview/v7.3/index.html"),"utf8");
  const sw=fs.readFileSync(path.join(ROOT,"preview/v7.3/sw.js"),"utf8");
  assert.doesNotMatch(html,/narou_shelf_mvp_v[123]|narou_shelf_pre_restore/,"no production storage key in preview");
  assert.match(html,/narou_shelf_preview_v7_3_data/);
  assert.match(html,/previewOnly!==true/,"only demo backups allowed");
  assert.match(sw,/key\.startsWith\(PREFIX\)/,"SW only deletes own caches");
  assert.match(sw,/self\.registration\.scope/,"SW checks its path");
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+server.address().port+PREFIX;
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:360,height:800},acceptDownloads:true});
    const page=await context.newPage();
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    page.on("dialog",dialog=>dialog.accept());
    await page.addInitScript(()=>{
      // The sentinel represents existing production data at the same origin.
      if(!localStorage.getItem("narou_shelf_mvp_v3"))localStorage.setItem("narou_shelf_mvp_v3","SENTINEL_KEEP_ME");
    });
    await page.goto(url);
    assert.match(await page.title(),/検証用/);
    assert.equal(await page.locator(".card").count(),3,"demo works seeded on first visit");
    assert.match(await page.locator(".preview-banner").innerText(),/サンプルデータのみ/);
    await page.locator('[data-action="plus"][data-id="demo-tracking"]').click();
    assert.match(await page.locator(".card").first().innerText(),/第6話/);
    await page.locator("#undoReadBtn").click();
    assert.match(await page.locator(".card").first().innerText(),/第5話/);

    await page.locator(".toolbar-more summary").click();
    const [fixtureDownload]=await Promise.all([page.waitForEvent("download"),page.locator("#fixtureBtn").click()]);
    assert.equal(fixtureDownload.suggestedFilename(),"narou_shelf_preview_fixture_v4.json");
    const fixture=JSON.parse(fs.readFileSync(await fixtureDownload.path(),"utf8"));
    assert.equal(fixture.previewOnly,true);
    assert.equal(fixture.version,4);

    await page.locator("#importFile").setInputFiles({
      name:fixtureDownload.suggestedFilename(),mimeType:"application/json",
      buffer:Buffer.from(JSON.stringify(fixture))
    });
    await page.locator("#restoreDialog").waitFor({state:"visible"});
    assert.match(await page.locator("#restorePreview").innerText(),/統合時に新規追加：1件/);
    await page.locator("#restoreApplyBtn").click();
    assert.equal(await page.locator(".card").count(),4);
    const state=await page.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_preview_v7_3_data")));
    assert.equal(state.find(x=>x.id==="demo-tracking").readEpisode,5);
    assert.equal(await page.evaluate(()=>localStorage.getItem("narou_shelf_mvp_v3")),"SENTINEL_KEEP_ME");

    await page.locator("#importFile").setInputFiles({
      name:"production.json",mimeType:"application/json",
      buffer:Buffer.from(JSON.stringify({version:4,books:fixture.books}))
    });
    assert.equal(await page.locator("#restoreDialog").isVisible(),false,"production backups are rejected in demo");
    assert.equal(await page.locator(".card").count(),4,"rejected backup keeps current preview data");

    await page.locator(".toolbar-more summary").click();
    const [backup]=await Promise.all([page.waitForEvent("download"),page.locator("#exportBtn").click()]);
    assert.match(backup.suggestedFilename(),/^narou_shelf_preview_backup_.*\.json$/);
    const backupData=JSON.parse(fs.readFileSync(await backup.path(),"utf8"));
    assert.equal(backupData.previewOnly,true);
    assert.equal(backupData.books.length,4);

    for(const width of [360,375,412]){
      await page.setViewportSize({width,height:800});
      const horizontal=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
      assert.ok(horizontal<=1,"no horizontal overflow at "+width+": "+horizontal);
    }
    await page.reload();
    assert.equal(await page.locator(".card").count(),4,"demo data survives reload");
    const scope=await page.evaluate(async()=>{
      const ready=await navigator.serviceWorker.ready;
      return ready.scope;
    });
    assert.ok(scope.endsWith(PREFIX),"SW scope restricted to preview folder");
    assert.equal(await page.evaluate(()=>localStorage.getItem("narou_shelf_mvp_v3")),"SENTINEL_KEEP_ME");

    await page.locator(".toolbar-more summary").click();
    await page.locator("#resetDemoBtn").click();
    assert.equal(await page.locator(".card").count(),3,"demo reset restores initial samples");
    assert.equal(await page.evaluate(()=>localStorage.getItem("narou_shelf_mvp_v3")),"SENTINEL_KEEP_ME");

    assert.deepEqual(errors,[],"no JS page errors");
    console.log("PASS: preview isolation, demo seed, read undo, v4 fixture, merge, rejects production JSON, backup, mobile widths, SW scope, reload, reset");
    await context.close();
  }finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;server.close()});
