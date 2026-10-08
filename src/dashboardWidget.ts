import type { McpServer } from "@modelcontextprotocol/server";

/**
 * The Daykeeper Dashboard UI: one self-contained MCP Apps resource. It makes
 * no network requests of its own (empty CSP allowlists) and talks to the host
 * only through the MCP Apps postMessage bridge (`ui/initialize`,
 * `ui/notifications/tool-result`, `tools/call`), falling back to the optional
 * `window.openai` bridge when present. It holds no credential: every action
 * is a tool call the host makes with the connection's own token.
 *
 * The URI is the cache key: publish a new version for any breaking change.
 */
export const DASHBOARD_WIDGET_URI = "ui://daykeeper/dashboard-v1.html";
export const DASHBOARD_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export interface DashboardWidgetOptions {
  /** Dedicated HTTPS origin for the widget sandbox (`_meta.ui.domain`). */
  readonly domain?: string;
}

export function dashboardWidgetMeta(options: DashboardWidgetOptions = {}) {
  return {
    ui: {
      prefersBorder: true,
      csp: { connectDomains: [], resourceDomains: [] },
      ...(options.domain ? { domain: options.domain } : {}),
    },
    "openai/widgetDescription":
      "Daykeeper inbox: conversations, replies, usage and settings for one workspace.",
    "openai/widgetPrefersBorder": true,
    "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
    ...(options.domain ? { "openai/widgetDomain": options.domain } : {}),
  };
}

export function registerDashboardWidget(
  server: McpServer,
  options: DashboardWidgetOptions = {},
): void {
  const meta = dashboardWidgetMeta(options);
  server.registerResource(
    "daykeeper_dashboard",
    DASHBOARD_WIDGET_URI,
    {
      title: "Daykeeper dashboard",
      description: "Daykeeper inbox, usage and settings.",
      mimeType: DASHBOARD_WIDGET_MIME_TYPE,
      _meta: meta,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: DASHBOARD_WIDGET_MIME_TYPE,
          text: DASHBOARD_WIDGET_HTML,
          _meta: meta,
        },
      ],
    }),
  );
}

const STYLE = `
:root{--bg:#fff;--fg:#0a0a0a;--muted:#6b6b6b;--line:#e5e5e5;--soft:#f5f5f5;--accent:#0a0a0a;--on-accent:#fff;--danger:#b00020}
:root[data-theme=dark]{--bg:#0a0a0a;--fg:#f5f5f5;--muted:#9a9a9a;--line:#262626;--soft:#161616;--accent:#f5f5f5;--on-accent:#0a0a0a;--danger:#ff6b6b}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
button,select,textarea{font:inherit;color:inherit}
button{background:var(--bg);border:1px solid var(--fg);border-radius:6px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
select{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;max-width:100%}
.app{display:flex;flex-direction:column;min-height:420px}
header{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;font-weight:700;margin:0 auto 0 0;letter-spacing:-.01em}
nav{display:flex;gap:4px;padding:8px 16px 0;border-bottom:1px solid var(--line)}
nav button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:8px 10px;color:var(--muted)}
nav button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg);font-weight:600}
main{padding:12px 16px 16px;flex:1}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}
.stat{border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
.stat b{display:block;font-size:12px;font-weight:500;color:var(--muted)}
.stat span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.split{display:grid;grid-template-columns:minmax(200px,38%) 1fr;border:1px solid var(--line);border-radius:8px;min-height:320px;overflow:hidden}
.list{border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}
.list-head{display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid var(--line)}
.list-head select{flex:1}
.items{list-style:none;margin:0;padding:0;overflow:auto;flex:1}
.items li button{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:10px}
.items li button[aria-current=true]{background:var(--soft)}
.items .meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
.items .preview{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.more{margin:8px;align-self:flex-start}
.thread{display:flex;flex-direction:column;min-width:0}
.thread-head{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--line)}
.thread-head .title{margin-right:auto;font-weight:600}
.messages{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:8px 10px;border-radius:10px;background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere}
.msg.out{align-self:flex-end;background:var(--accent);color:var(--on-accent)}
.msg.note{align-self:center;background:transparent;color:var(--muted);font-size:12px}
.msg time{display:block;font-size:11px;opacity:.7;margin-top:2px}
.compose{border-top:1px solid var(--line);padding:8px;display:flex;flex-direction:column;gap:6px}
.compose textarea{width:100%;min-height:64px;resize:vertical;border:1px solid var(--line);border-radius:6px;padding:8px;background:var(--bg)}
.compose .row{display:flex;gap:8px;align-items:center}
.compose .row .status{margin-right:auto;font-size:12px;color:var(--muted)}
.empty{color:var(--muted);padding:16px;text-align:center}
.back{display:none}
.error{color:var(--danger)}
table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:8px;border-bottom:1px solid var(--line)}
th{font-weight:500;color:var(--muted)}
.setting{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:8px;padding:12px}
.switch{position:relative;width:40px;height:22px;border-radius:11px;border:1px solid var(--fg);padding:0;background:var(--bg)}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--fg);transition:left .15s}
.switch[aria-checked=true]{background:var(--accent)}
.switch[aria-checked=true]::after{left:20px;background:var(--on-accent)}
[hidden]{display:none!important}
@media (max-width:640px){
 .stats{grid-template-columns:1fr}
 .split{grid-template-columns:1fr}
 .list{border-right:0}
 .split.show-thread .list{display:none}
 .split:not(.show-thread) .thread{display:none}
 .back{display:inline-block}
}
`;

/**
 * Whether a failed send must keep its idempotency key (and draft). Only a
 * tool result that is an error, carries no unknown outcome and is not
 * REQUEST_IN_PROGRESS is a definite refusal; everything else (timeouts,
 * bridge errors, missing data) may have sent the reply. Plain ES5, embedded
 * verbatim in the widget and evaluated directly by tests.
 */
export const KEEPS_REPLY_KEY_SOURCE = `function keepsReplyKey(e){
 if(!e||e.refused!==true)return true;
 if(e.outcome)return true;
 if(e.code==="REQUEST_IN_PROGRESS")return true;
 return false;
}`;

const SCRIPT = `
(function(){
"use strict";
${KEEPS_REPLY_KEY_SOURCE}
var state={data:null,workspaceId:null,tab:"inbox",filter:"open",list:[],cursor:null,selected:null,thread:[],threadCursor:null,email:null,draft:null,busy:false};
var pending=new Map();var nextId=1;var bridge=false;
function $(id){return document.getElementById(id)}
function el(tag,attrs,text){var n=document.createElement(tag);if(attrs)for(var k in attrs){if(k==="class")n.className=attrs[k];else n.setAttribute(k,attrs[k])}if(text!==undefined&&text!==null)n.textContent=String(text);return n}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function send(msg){window.parent.postMessage(msg,"*")}
function request(method,params){var id=nextId++;send({jsonrpc:"2.0",id:id,method:method,params:params});return new Promise(function(resolve,reject){pending.set(id,{resolve:resolve,reject:reject});setTimeout(function(){if(pending.has(id)){pending.delete(id);reject({message:"Timed out"})}},60000)})}
function callTool(name,args){
 if(bridge)return request("tools/call",{name:name,arguments:args});
 var o=window.openai;if(o&&typeof o.callTool==="function")return Promise.resolve(o.callTool(name,args));
 return Promise.reject({message:"Unavailable"});
}
function result(r){
 if(!r)throw {message:"No response"};
 var s=r.structuredContent;
 if(r.isError){var e=(s&&s.error)||{};throw {refused:true,code:e.code,message:e.message||"Failed",outcome:e.outcome,idempotencyKey:e.idempotencyKey}}
 if(!s)throw {message:"No data"};
 return s;
}
function fmtTime(v){if(!v)return "";var d=new Date(v);if(isNaN(d.getTime()))return "";return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}
function num(v){return typeof v==="number"?v.toLocaleString():"-"}
function usageLine(u){if(!u)return "-";return num(u.conversations.used)+" conv · "+num(u.messages.used)+" msg"}
function setStatus(id,text,isError){var n=$(id);n.textContent=text||"";n.classList.toggle("error",!!isError)}
function resize(){try{var h=document.documentElement.scrollHeight;if(bridge)send({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{width:document.documentElement.scrollWidth,height:h}});var o=window.openai;if(o&&typeof o.notifyIntrinsicHeight==="function")o.notifyIntrinsicHeight(h)}catch(e){}}

function applyDashboard(d){
 if(!d||!Array.isArray(d.workspaces))return;
 state.data=d;state.workspaceId=d.workspaceId;
 var sel=$("workspace");clear(sel);
 d.workspaces.forEach(function(w){var o=el("option",{value:w.id},w.name);if(w.id===d.workspaceId)o.selected=true;sel.appendChild(o)});
 sel.disabled=d.workspaces.length<2;
 $("inbox-status").textContent=d.inbox?(d.inbox.trafficEnabled?"Live":d.inbox.state):"-";
 $("plan").textContent=d.plan&&d.plan.name?d.plan.name.charAt(0).toUpperCase()+d.plan.name.slice(1):"-";
 $("usage-line").textContent=usageLine(d.usage);
 renderUsage(d.usage);
 var c=d.inboxConversations;
 state.filter="open";$("filter").value="open";
 if(c){state.list=c.conversations;state.cursor=c.nextCursor}else{state.list=[];state.cursor=null}
 if(state.selected&&!state.list.some(function(x){return x.id===state.selected.id}))closeThread();
 renderList();
 if(!d.workspaceId){$("list-empty").textContent="No workspace"}
 state.email=null;if(state.tab==="settings")loadEmail();
 resize();
}
function renderList(){
 var ul=$("items");clear(ul);
 state.list.forEach(function(c){
  var li=el("li");var b=el("button",{type:"button"});
  if(state.selected&&state.selected.id===c.id)b.setAttribute("aria-current","true");
  var m=el("span",{class:"meta"});m.appendChild(el("span",null,"#"+c.id+" · "+c.status));m.appendChild(el("span",null,fmtTime(c.lastActivityAt||c.updatedAt||c.createdAt)));
  b.appendChild(m);b.appendChild(el("span",{class:"preview"},c.preview||"-"));
  b.onclick=function(){openThread(c)};li.appendChild(b);ul.appendChild(li);
 });
 $("list-empty").hidden=state.list.length>0;$("list-empty").textContent="No conversations";
 $("more").hidden=!state.cursor;
 resize();
}
function loadList(append){
 if(!state.workspaceId)return;
 var args={workspaceId:state.workspaceId,status:state.filter};if(append&&state.cursor)args.cursor=state.cursor;
 $("more").disabled=true;
 callTool("list_conversations",args).then(result).then(function(s){state.list=append?state.list.concat(s.conversations):s.conversations;state.cursor=s.nextCursor;renderList()}).catch(function(e){$("list-empty").hidden=false;$("list-empty").textContent=e.message||"Failed"}).then(function(){$("more").disabled=false});
}
function openThread(c){
 state.selected=c;state.thread=[];state.threadCursor=null;
 $("split").classList.add("show-thread");$("thread-empty").hidden=true;$("thread-body").hidden=false;
 $("thread-title").textContent="#"+c.id;$("reply").value="";setStatus("send-status","");
 updateResolve();renderList();loadThread(false);
}
function closeThread(){state.selected=null;$("split").classList.remove("show-thread");$("thread-empty").hidden=false;$("thread-body").hidden=true;renderList()}
function updateResolve(){var c=state.selected;$("resolve").textContent=c&&c.status==="resolved"?"Reopen":"Resolve"}
function loadThread(older){
 var c=state.selected;if(!c)return;
 var args={workspaceId:state.workspaceId,conversationId:c.id};if(older&&state.threadCursor)args.cursor=state.threadCursor;
 callTool("get_conversation",args).then(result).then(function(s){
  if(!state.selected||state.selected.id!==c.id)return;
  state.thread=older?s.messages.concat(state.thread):s.messages;state.threadCursor=s.nextCursor;renderThread();
 }).catch(function(e){setStatus("send-status",e.message||"Failed",true)});
}
function renderThread(){
 var box=$("messages");clear(box);
 if(state.threadCursor){var b=el("button",{type:"button",class:"more"},"Earlier");b.onclick=function(){loadThread(true)};box.appendChild(b)}
 var sorted=state.thread.slice().sort(function(a,b){return String(a.createdAt).localeCompare(String(b.createdAt))});
 sorted.forEach(function(m){
  var cls=m.messageType===2?"msg note":(m.messageType===1?"msg out":"msg");
  var d=el("div",{class:cls});d.appendChild(document.createTextNode(m.content));d.appendChild(el("time",null,fmtTime(m.createdAt)));box.appendChild(d);
 });
 if(!sorted.length)box.appendChild(el("div",{class:"empty"},"No messages"));
 box.scrollTop=box.scrollHeight;resize();
}
function sendReply(){
 var c=state.selected;var text=$("reply").value;if(!c||!text.trim()||state.busy)return;
 // One key per intended reply: an uncertain attempt is retried with the same key.
 if(!state.draft||state.draft.text!==text||state.draft.conversationId!==c.id)state.draft={text:text,conversationId:c.id,key:newKey()};
 state.busy=true;$("send").disabled=true;setStatus("send-status","Sending");
 callTool("send_reply",{workspaceId:state.workspaceId,conversationId:c.id,content:text,idempotencyKey:state.draft.key}).then(result).then(function(s){
  state.draft=null;$("reply").value="";setStatus("send-status","Sent");state.thread=state.thread.concat([s.message]);renderThread();
 }).catch(function(e){
  // Only a definite refusal releases the key. A timeout, a bridge failure,
  // an in-progress send or an unknown outcome keeps it for the retry.
  if(keepsReplyKey(e))setStatus("send-status","Not confirmed. Check before resending.",true);
  else{state.draft=null;setStatus("send-status",e.message||"Not sent",true)}
 }).then(function(){state.busy=false;$("send").disabled=false});
}
function newKey(){try{if(crypto&&crypto.randomUUID)return crypto.randomUUID()}catch(e){}var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(x){return("0"+x.toString(16)).slice(-2)}).join("")}
function toggleStatus(){
 var c=state.selected;if(!c||state.busy)return;var next=c.status==="resolved"?"open":"resolved";
 state.busy=true;$("resolve").disabled=true;
 callTool("set_conversation_status",{workspaceId:state.workspaceId,conversationId:c.id,status:next}).then(result).then(function(s){
  c.status=s.status;updateResolve();
  if(state.filter!=="all"&&state.filter!==s.status){state.list=state.list.filter(function(x){return x.id!==c.id});closeThread()}else renderList();
 }).catch(function(e){setStatus("send-status",e.message||"Failed",true)}).then(function(){state.busy=false;$("resolve").disabled=false});
}
function renderUsage(u){
 var t=$("usage-table");clear(t);
 if(!u){t.appendChild(el("tr",null)).appendChild(el("td",{class:"empty"},"Unavailable"));return}
 var head=el("tr");["","Used","Limit"].forEach(function(h){head.appendChild(el("th",null,h))});t.appendChild(head);
 [["Conversations",u.conversations],["Messages",u.messages],["Contacts",u.contacts]].forEach(function(r){var tr=el("tr");tr.appendChild(el("td",null,r[0]));tr.appendChild(el("td",null,num(r[1].used)));tr.appendChild(el("td",null,r[1].limit===null?"-":num(r[1].limit)));t.appendChild(tr)});
 $("period").textContent=fmtTime(u.periodStart)+" – "+fmtTime(u.periodEnd);
}
function loadEmail(){
 if(!state.workspaceId)return;var sw=$("email-switch");sw.disabled=true;setStatus("email-status","");
 callTool("get_customer_email",{workspaceId:state.workspaceId}).then(result).then(function(s){state.email=s;sw.setAttribute("aria-checked",String(s.enabled));sw.disabled=false}).catch(function(e){setStatus("email-status",e.message||"Unavailable",true)});
}
function toggleEmail(){
 var sw=$("email-switch");if(!state.email||sw.disabled)return;var next=!state.email.enabled;sw.disabled=true;
 callTool("set_customer_email",{workspaceId:state.workspaceId,enabled:next}).then(result).then(function(s){state.email=s;sw.setAttribute("aria-checked",String(s.enabled));setStatus("email-status","Saved")}).catch(function(e){setStatus("email-status",e.message||"Failed",true)}).then(function(){sw.disabled=false});
}
function refresh(workspaceId){
 var args=workspaceId?{workspaceId:workspaceId}:(state.workspaceId?{workspaceId:state.workspaceId}:{});
 $("refresh").disabled=true;
 callTool("get_dashboard",args).then(result).then(applyDashboard).catch(function(e){$("list-empty").hidden=false;$("list-empty").textContent=e.message||"Failed"}).then(function(){$("refresh").disabled=false});
}
function selectTab(name){
 state.tab=name;["inbox","usage","settings"].forEach(function(t){$("tab-"+t).setAttribute("aria-selected",String(t===name));$("panel-"+t).hidden=t!==name});
 if(name==="settings"&&!state.email)loadEmail();resize();
}
function applyTheme(ctx){if(ctx&&(ctx.theme==="dark"||ctx.theme==="light"))document.documentElement.setAttribute("data-theme",ctx.theme)}

window.addEventListener("message",function(event){
 if(event.source!==window.parent)return;var m=event.data;if(!m||m.jsonrpc!=="2.0")return;
 if(m.id!==undefined&&m.method===undefined&&pending.has(m.id)){var p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(m.error);else p.resolve(m.result);return}
 if(m.method==="ui/notifications/tool-result"){var s=m.params&&m.params.structuredContent;if(s&&!m.params.isError)applyDashboard(s);return}
 if(m.method==="ui/notifications/host-context-changed"){applyTheme(m.params);return}
},{passive:true});
window.addEventListener("openai:set_globals",function(){var o=window.openai;if(o){applyTheme({theme:o.theme});if(o.toolOutput&&!state.data)applyDashboard(o.toolOutput)}});

$("tab-inbox").onclick=function(){selectTab("inbox")};$("tab-usage").onclick=function(){selectTab("usage")};$("tab-settings").onclick=function(){selectTab("settings")};
$("refresh").onclick=function(){refresh()};
$("workspace").onchange=function(e){closeThread();refresh(e.target.value)};
$("filter").onchange=function(e){state.filter=e.target.value;closeThread();loadList(false)};
$("more").onclick=function(){loadList(true)};
$("back").onclick=closeThread;$("send").onclick=sendReply;$("resolve").onclick=toggleStatus;$("email-switch").onclick=toggleEmail;
if(typeof ResizeObserver==="function")new ResizeObserver(resize).observe(document.body);

request("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:"daykeeper-dashboard",version:"1"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]}}).then(function(r){
 bridge=true;applyTheme(r&&r.hostContext);send({jsonrpc:"2.0",method:"ui/notifications/initialized"});resize();
}).catch(function(){});
var o=window.openai;if(o){applyTheme({theme:o.theme});if(o.toolOutput)applyDashboard(o.toolOutput)}
})();
`;

const BODY = `
<div class="app">
<header><h1>Daykeeper</h1><select id="workspace" aria-label="Workspace"></select><button id="refresh" type="button">Refresh</button></header>
<nav role="tablist"><button id="tab-inbox" role="tab" type="button" aria-selected="true">Inbox</button><button id="tab-usage" role="tab" type="button" aria-selected="false">Usage</button><button id="tab-settings" role="tab" type="button" aria-selected="false">Settings</button></nav>
<main>
<section id="panel-inbox">
<div class="stats"><div class="stat"><b>Inbox status</b><span id="inbox-status">-</span></div><div class="stat"><b>Plan</b><span id="plan">-</span></div><div class="stat"><b>Usage</b><span id="usage-line">-</span></div></div>
<div class="split" id="split">
<div class="list"><div class="list-head"><select id="filter" aria-label="Status"><option value="open">Open</option><option value="resolved">Resolved</option><option value="pending">Pending</option><option value="snoozed">Snoozed</option><option value="all">All</option></select></div><ul class="items" id="items"></ul><div class="empty" id="list-empty">Loading</div><button class="more" id="more" type="button" hidden>More</button></div>
<div class="thread"><div class="empty" id="thread-empty">Select a conversation</div>
<div id="thread-body" hidden style="display:flex;flex-direction:column;flex:1;min-height:0">
<div class="thread-head"><button class="back" id="back" type="button" aria-label="Back">Back</button><span class="title" id="thread-title"></span><button id="resolve" type="button">Resolve</button></div>
<div class="messages" id="messages"></div>
<div class="compose"><textarea id="reply" aria-label="Reply" placeholder="Reply"></textarea><div class="row"><span class="status" id="send-status"></span><button class="primary" id="send" type="button">Send</button></div></div>
</div></div>
</div>
</section>
<section id="panel-usage" hidden><table id="usage-table"></table><p class="empty" id="period"></p></section>
<section id="panel-settings" hidden><div class="setting"><span>Customer email</span><button class="switch" id="email-switch" type="button" role="switch" aria-checked="false" aria-label="Customer email" disabled></button></div><p class="empty" id="email-status"></p></section>
</main>
</div>
`;

export const DASHBOARD_WIDGET_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daykeeper</title><style>${STYLE}</style></head><body>${BODY}<script>${SCRIPT}</script></body></html>`;
