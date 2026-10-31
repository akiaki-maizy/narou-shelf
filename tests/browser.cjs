const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const http=require("node:http");
const {chromium}=require("playwright");
const ROOT=path.resolve(__dirname,"..");
const allowed=new Set(["/","/index.html","/sw.js","/manifest.webmanifest"]);
const sample=[
  {id:"tracking",url:"https://ncode.syosetu.com/n1234aa/",title:"追跡している作品",status:"tracking",readEpisode:2,latestEpisode:5,generalLastup:"2026-10-30"},
  {id:"unread",url:"https://novel18.syosetu.com/n1234bb/",title:"まだ読んでいない作品",status:"unread",readEpisode:0,latestEpisode:10,generalLastup:"2026-10-01"},
  {id:"paused",url:"https://ncode.syosetu.com/n1234cc/",title:"保留中の作品",status:"paused",readEpisode:1,latestEpisode:2}
];
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,"http://localhost").pathname;
  if(!allowed.has(pathname)){res.writeHead(404);return res.end("Not found")}
  const name=pathname==="/"?"/index.html":pathname;
  const type=name.endsWith(".js")?"text/javascript":name.endsWith(".webmanifest")?"application/manifest+json":"text/html";
  res.writeHead(200,{"Content-Type":type+"; charset=utf-8","Cache-Control":"no-store"});
  fs.createReadStream(path.join(ROOT,name)).pipe(res);
});
const listen=()=>new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const close=()=>new Promise(resolve=>server.close(resolve));

async function main(){
  await listen();
  const base="http://127.0.0.1:"+server.address().port+"/";
  const browser=await chromium.launch({headless:true});
  const errors=[];
  try{
    const context=await browser.newContext({viewport:{width:375,height:812},acceptDownloads:true});
    const page=await context.newPage();
    page.on("pageerror",error=>errors.push(error.message));
    page.on("dialog",dialog=>dialog.accept());
    await page.goto(base);
    await page.evaluate(data=>localStorage.setItem("narou_shelf_mvp_v3",JSON.stringify(data)),sample);
    await page.reload();
    assert.equal(await page.locator(".card").count(),3,"all existing records displayed");
    assert.match(await page.locator(".card").first().innerText(),/追跡している作品/,"unread tracking comes first");
    assert.equal(await page.locator("#sortBy").inputValue(),"attention");

    await page.locator('[data-action="plus"][data-id="tracking"]').click();
    let stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_mvp_v3")));
    assert.equal(stored.find(x=>x.id==="tracking").readEpisode,3);
    assert.equal(await page.locator("#undoToast").isVisible(),true);
    await page.locator("#undoReadBtn").click();
    stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_mvp_v3")));
    assert.equal(stored.find(x=>x.id==="tracking").readEpisode,2);
    assert.equal(await page.locator("#undoToast").isVisible(),false);
    
    await page.locator('[data-action="plus"][data-id="unread"]').click();
    stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_mvp_v3")));
    assert.equal(stored.find(x=>x.id==="unread").status,"tracking");
    await page.locator("#undoReadBtn").click();

    const payload={
      version:4,exportedAt:"2026-10-30T14:00:00Z",books:[
        {id:"other",url:"https://ncode.syosetu.com/n1234aa/3/",title:"上書きされない作品",readEpisode:0},
        {id:"tracking",url:"https://ncode.syosetu.com/n9999zz/",title:"復元で追加",readEpisode:1,latestEpisode:9},
        {id:"another",url:"https://ncode.syosetu.com/n9999zz/2/",title:"重複分"}
      ]
    };
    await page.locator("#importFile").setInputFiles({
      name:"old-backup.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(payload))
    });
    await page.locator("#restoreDialog").waitFor({state:"visible"});
    assert.match(await page.locator("#restorePreview").innerText(),/重複除外後：2件/);
    assert.match(await page.locator("#restorePreview").innerText(),/統合時に新規追加：1件/);
    assert.equal(await page.locator('input[name="restoreMode"]:checked').inputValue(),"merge");
    fs.mkdirSync(path.join(ROOT,"artifacts"),{recursive:true});
    await page.screenshot({path:path.join(ROOT,"artifacts","v7.3-restore-preview.png"),fullPage:true});
    await page.locator("#restoreApplyBtn").click();
    stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_mvp_v3")));
    assert.equal(stored.length,4);
    assert.equal(stored.find(x=>x.id==="tracking").readEpisode,2,"local progress retained on merge");
    assert.equal(stored.filter(x=>x.url.includes("n9999zz")).length,1);
    assert.equal(new Set(stored.map(x=>x.id)).size,4,"duplicate internal IDs repaired");
    const pre=await page.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_pre_restore")));
    assert.equal(pre.length,3);

    await page.locator(".toolbar-more summary").click();
    const [download]=await Promise.all([
      page.waitForEvent("download"),
      page.locator("#exportBtn").click()
    ]);
    assert.match(download.suggestedFilename(),/^narou_shelf_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json$/);
    const json=JSON.parse(fs.readFileSync(await download.path(),"utf8"));
    assert.equal(json.version,5);
    assert.equal(json.books.length,4);

    await page.reload();
    assert.equal(await page.locator(".card").count(),4,"restored records survive reload");
    for(const width of [360,375,412]){
      await page.setViewportSize({width,height:812});
      const dims=await page.evaluate(()=>({
        viewport:window.innerWidth,
        document:document.documentElement.scrollWidth,
        body:document.body.scrollWidth
      }));
      assert.ok(dims.document<=dims.viewport+1,"no horizontal scroll at "+width+": "+JSON.stringify(dims));
      await page.screenshot({path:path.join(ROOT,"artifacts","v7.3-mobile-"+width+".png"),fullPage:true});
      await page.locator(".toolbar-more summary").click();
      assert.equal(await page.locator("#importBtn").isVisible(),true);
      await page.locator(".toolbar-more summary").click();
    }
    assert.deepEqual(errors,[],"no uncaught page errors");

    const replaceContext=await browser.newContext({viewport:{width:375,height:812}});
    const replacePage=await replaceContext.newPage();
    replacePage.on("dialog",dialog=>dialog.accept());
    await replacePage.goto(base);
    await replacePage.evaluate(data=>localStorage.setItem("narou_shelf_mvp_v3",JSON.stringify(data)),sample);
    await replacePage.reload();
    await replacePage.locator("#importFile").setInputFiles({
      name:"corrupt.json",mimeType:"application/json",buffer:Buffer.from("{invalid JSON")
    });
    let afterInvalid=await replacePage.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_mvp_v3")));
    assert.equal(afterInvalid.length,3,"invalid JSON never alters records");
    assert.equal(await replacePage.locator("#restoreDialog").isVisible(),false,"invalid JSON does not open restore dialog");

    await replacePage.locator("#importFile").setInputFiles({
      name:"valid.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(payload))
    });
    await replacePage.locator("#restoreDialog").waitFor({state:"visible"});
    await replacePage.locator('input[name="restoreMode"][value="replace"]').check();
    await replacePage.locator("#restoreApplyBtn").click();
    const replaced=await replacePage.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_mvp_v3")));
    assert.equal(replaced.length,2,"replacement uses unique incoming entries");
    assert.equal(replaced.some(x=>x.title==="追跡している作品"),false,"replacement truly replaces old records");
    const replaceSnapshot=await replacePage.evaluate(()=>JSON.parse(localStorage.getItem("narou_shelf_pre_restore")));
    assert.equal(replaceSnapshot.length,3,"replacement keeps pre-restore snapshot");
    await replaceContext.close();
    await context.close();
    console.log("PASS: Chromium UI, one-click read and undo, merge/replace, corrupt backup isolation, browser download, reload, responsive screenshots");
  }finally{
    await browser.close();
    await close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;server.close()});
