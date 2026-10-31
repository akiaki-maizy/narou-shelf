const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("index.html", "utf8");
const code = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(code, "inline script exists");
assert.match(html, /v7\.3/);

const store = new Map();
store.set("narou_shelf_mvp_v3", JSON.stringify([
  {id:"one",url:"https://ncode.syosetu.com/n1234aa/",title:"作品A",status:"tracking",readEpisode:2,latestEpisode:4,generalLastup:"2026-10-29"},
  {id:"two",url:"https://novel18.syosetu.com/n1234bb/",title:"作品B",status:"unread",readEpisode:0,latestEpisode:10}
]));
const el = new Map();
function element(id) {
  if (!el.has(id)) {
    const obj = {
      id, value:"", innerHTML:"", textContent:"", hidden:false, disabled:false,
      listeners:{}, className:"", checked:false, open:false, files:[],
      addEventListener(type,callback){this.listeners[type]=callback},
      showModal(){this.open=true}, close(){this.open=false;this.listeners.close?.()},
      reset(){}, click(){}, remove(){},
    };
    if(id==="sortBy")obj.value="attention";
    el.set(id,obj);
  }
  return el.get(id);
}
const mode = {checked:true,value:"merge"};
const document = {
  getElementById:element,
  querySelectorAll:()=>[],
  querySelector:()=>mode,
  createElement:()=>({style:{},click(){},remove(){}}),
  head:{appendChild(){}},
  body:{appendChild(){}}
};
const localStorage = {
  getItem:key=>store.has(key)?store.get(key):null,
  setItem:(key,value)=>store.set(key,value),
};
const alerts=[];
const window = {addEventListener(){}};
const ctx = vm.createContext({
  document, window, localStorage, navigator:{},
  URL, URLSearchParams, Blob, Date, Math, Number, String, JSON,
  crypto:{randomUUID:()=>"uuid-test"},
  setTimeout, clearTimeout,
  alert:message=>alerts.push(message),
  confirm:()=>true
});
vm.runInContext(code,ctx,{filename:"index.html"});
const run=source=>vm.runInContext(source,ctx);

assert.equal(run("books.length"),2,"legacy localStorage key remains readable");
assert.equal(run('parseNarouUrl("https://novel18.syosetu.com/n1234bb/7/").episode'),7);
assert.equal(run("attentionRank(books[0])"),0,"tracking with unread ranks first");
assert.equal(run("attentionRank(books[1])"),1,"unread state ranks second");

run('markOneRead("one")');
assert.equal(run("books[0].readEpisode"),3);
assert.equal(JSON.parse(store.get("narou_shelf_mvp_v3"))[0].readEpisode,3);
assert.equal(element("undoToast").hidden,false);
run("undoLastRead()");
assert.equal(run("books[0].readEpisode"),2,"undo restores previous episode");
assert.equal(element("undoToast").hidden,true);

run('markOneRead("two")');
assert.equal(run("books[1].status"),"tracking","unread converts to tracking on progress");
run("undoLastRead()");
assert.equal(run("books[1].status"),"unread","undo restores previous status");
run("books[0].readEpisode=4; save()");
run('markOneRead("one")');
assert.equal(run("books[0].readEpisode"),4,"progress never exceeds known latest episode");

const merged=JSON.parse(run('JSON.stringify(mergeImportedBooks(books,[{id:"duplicate",url:"https://ncode.syosetu.com/n1234aa/4/",title:"違うタイトル"},{id:"new",url:"https://ncode.syosetu.com/n9999zz/",title:"新規"}]))'));
assert.equal(merged.length,3);
assert.equal(merged[0].title,"作品A","merge retains current progress and metadata");
assert.equal(merged[2].title,"新規");

async function testRestore() {
  const original=store.get("narou_shelf_mvp_v3");
  const incoming={
    version:4,exportedAt:"2026-10-30T14:00:00Z",
    books:[
      {id:"dupe",url:"https://ncode.syosetu.com/n1234aa/4/",title:"上書きされない",readEpisode:0},
      {id:"new",url:"https://ncode.syosetu.com/n9999zz/",title:"追加作品",readEpisode:1},
      {id:"dupe2",url:"https://ncode.syosetu.com/n9999zz/2/",title:"重複作品"}
    ]
  };
  await element("importFile").listeners.change({target:{
    files:[{text:async()=>JSON.stringify(incoming)}],value:"backup.json"
  }});
  assert.equal(element("restoreDialog").open,true,"restore preview opens before write");
  assert.match(element("restorePreview").textContent,/重複除外後：2件/);
  assert.equal(store.get("narou_shelf_mvp_v3"),original,"preview does not overwrite");
  element("restoreApplyBtn").listeners.click();
  assert.equal(element("restoreDialog").open,false);
  const restored=JSON.parse(store.get("narou_shelf_mvp_v3"));
  assert.equal(restored.length,3);
  assert.equal(restored[0].title,"作品A","existing copy wins when merging");
  assert.equal(JSON.parse(store.get("narou_shelf_pre_restore")).length,2,"pre-restore snapshot saved");
  assert.equal(restored[2].title,"追加作品");
  console.log("PASS: source syntax, legacy load, sorting, one-click read+undo, max cap, merge, preview, restore snapshot");
}
testRestore().catch(error=>{console.error(error);process.exitCode=1});
