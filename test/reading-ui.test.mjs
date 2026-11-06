import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';

// Actual Whiteboard/BoardSync/reading overlay, native lifecycle + DOM stubs only.
// Not browser layout or native pointer-engine acceptance evidence.
const native = `import React from 'react';
class Native extends React.Component {
 state={revision:0,viewModeEnabled:false,selectedElementIds:{}};
 componentDidMount(){ const h=globalThis.__readingUI; h.native=this; h.mounts++; this.props.excalidrawAPI(h.api); }
 componentDidUpdate(prev,prevState){ const h=globalThis.__readingUI;
  if (++h.callbacks>400) throw new Error('unbounded reading lifecycle');
  Object.assign(h.state,{viewModeEnabled:this.state.viewModeEnabled,selectedElementIds:this.state.selectedElementIds});
  // Exact pinned order: prop update queues mode, next cDU queues deselection,
  // and each phase notifies onChange BEFORE its queued setState is committed.
  if(prev.viewModeEnabled!==this.props.viewModeEnabled)this.setState({viewModeEnabled:this.props.viewModeEnabled});
  if(prevState.viewModeEnabled!==this.state.viewModeEnabled)this.setState({selectedElementIds:{}});
  this.props.onChange(h.elements,h.state,h.files);
 }
 componentWillUnmount(){globalThis.__readingUI.unmounts++;}
 render(){return React.createElement('native-editor',this.props);}
}
export const Excalidraw=React.memo(Native);
export function MainMenu({children}){return children;}
MainMenu.DefaultItems={ClearCanvas:()=>null,ToggleTheme:()=>null};
export const CaptureUpdateAction={NEVER:'NEVER',IMMEDIATELY:'IMMEDIATELY'};
export const restoreElements=e=>e;
export const newElementWith=(e,u)=>({...e,...u});
export const exportToBlob=()=>null,exportToSvg=()=>null,serializeAsJSON=()=>'';`;

test('reading clicks highlight direct relations without native edits, writes, lost selection or ownership leaks', async () => {
  const root=fileURLToPath(new URL('..',import.meta.url));
  const output=join(root,'node_modules',`.reading-ui-${process.pid}.mjs`);
  const keys=['document','window','localStorage','requestAnimationFrame','cancelAnimationFrame','setInterval','clearInterval','__readingUI'];
  const previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  class Node {
    children=[];parentNode=null;
    appendChild(child){child.remove();this.children.push(child);child.parentNode=this;}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
    contains(child){return child===this||this.children.some(n=>n.contains?.(child));}
    focus(){document.activeElement=this;}
  }
  const rect=(id,x)=>({id,type:'rectangle',x,y:0,width:80,height:50,angle:0,version:1,versionNonce:1,isDeleted:false});
  const edge=(id,a,b,x)=>({id,type:'arrow',x,y:25,width:120,height:0,angle:0,points:[[0,0],[120,0]],startBinding:{elementId:a},endBinding:{elementId:b},roundness:null,version:1,versionNonce:1,isDeleted:false});
  const original=[rect('a',0),rect('b',200),rect('c',400),edge('ab','a','b',80),edge('bc','b','c',280),{...rect('frame',600),type:'frame',width:100,height:100},{...rect('framed',680),y:20,frameId:'frame'}];
  const h={elements:[],files:{},state:{zoom:{value:2},scrollX:20,scrollY:-30,offsetLeft:40,offsetTop:50,width:600,height:400,selectedElementIds:{},activeTool:{type:'selection'},viewModeEnabled:false},mounts:0,unmounts:0,callbacks:0,clears:0,changes:[]};
  const rerender=()=>h.native.setState(s=>({revision:s.revision+1}));
  h.api={getAppState:()=>h.state,getSceneElements:()=>h.elements.filter(e=>!e.isDeleted),getSceneElementsIncludingDeleted:()=>h.elements,getFiles:()=>h.files,addFiles(files){for(const file of files)h.files[file.id]=file;},refresh(){},scrollToContent(){},setActiveTool(t){h.state.activeTool=t;rerender();},history:{clear(){h.clears++;}},updateScene(change){h.changes.push(structuredClone(change));if(change.elements)h.elements=change.elements;Object.assign(h.state,change.appState);h.native.setState(s=>({...change.appState,revision:s.revision+1}));}};
  let renderer,writes=0,reads=0;
  const intervals=new Set();
  const storage=new Map();
  let server={sessionId:'reading-session',boardId:'default',revision:1,elements:structuredClone(original),files:{'accepted-file':{id:'accepted-file',mimeType:'image/png',dataURL:'data:image/png;base64,iVBORw0KGgo=',created:1}},selectedIds:['a']};
  try {
    globalThis.document={body:new Node(),activeElement:null,createElement:()=>new Node()};
    globalThis.window=new EventTarget();
    globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
    globalThis.requestAnimationFrame=callback=>setTimeout(callback,0);globalThis.cancelAnimationFrame=clearTimeout;
    globalThis.setInterval=(callback,delay)=>{const item={callback,delay};intervals.add(item);return item;};globalThis.clearInterval=item=>intervals.delete(item);
    globalThis.__readingUI=h;
    const result=await build({stdin:{contents:"export {Whiteboard} from './src/Whiteboard.jsx';",resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'esm',platform:'node',external:['react'],plugins:[{name:'reading-native-stub',setup(build){
      build.onResolve({filter:/^(@excalidraw\/excalidraw|react-dom)$/},args=>({path:args.path,namespace:'reading-stub'}));
      build.onLoad({filter:/.*/,namespace:'reading-stub'},args=>({loader:'js',contents:args.path==='react-dom'?"import React from 'react'; export const createPortal=(children,container)=>React.createElement('portal',{container},children);":native}));
    }}]});
    await writeFile(output,result.outputFiles[0].text);
    const {Whiteboard}=await import(pathToFileURL(output).href);
    const rpc=async(method,payload)=>{if(method==='save'){writes++;server={...server,...structuredClone(payload.scene),revision:server.revision+1};}else reads++;return structuredClone({...server,boardId:payload.boardId});};
    const controller=new AbortController();
    let props={sessionId:'reading-session',rpc,signal:controller.signal};
    await act(async()=>{renderer=create(React.createElement(Whiteboard,props),{createNodeMock:()=>new Node()});});
    const button=label=>renderer.root.findAllByType('button').find(n=>n.props['aria-label']===label);
    const more=()=>renderer.root.findByProps({'data-dsh-wb-menu':'tools'}).findByType('summary');
    const openMore=async()=>act(async()=>more().props.onClick({preventDefault(){}}));
    const editor=()=>renderer.root.findByType('native-editor');
    const canvas=()=>renderer.root.findByProps({className:'dsh-wb-canvas'});
    const focus=()=>renderer.root.findAllByType('svg').find(n=>n.props['data-reading-focus'])?.props['data-reading-focus'];
    const highlights=()=>renderer.root.findAll(n=>n.type==='g'&&n.props['data-reading-element']).map(n=>n.props['data-reading-element']);
    const pointer=(type,{x=30,y=20,id=1,button=0,target={tagName:'CANVAS'},...rest}={})=>{
      const values={clientX:(x+h.state.scrollX)*h.state.zoom.value+h.state.offsetLeft,clientY:(y+h.state.scrollY)*h.state.zoom.value+h.state.offsetTop,pointerId:id,button,target,...rest};
      if(type==='pointerdown')canvas().props.onPointerDownCapture(values);
      else{const event=new Event(type);for(const [key,value]of Object.entries(values))Object.defineProperty(event,key,{value});window.dispatchEvent(event);}
    };
    const click=async(options)=>act(async()=>{pointer('pointerdown',options);pointer('pointerup',options);});
    const poll=async()=>act(async()=>{for(const item of intervals)await item.callback();});
    const initialChanges=h.changes.length,initialClears=h.clears,initialMounts=h.mounts;
    await openMore();
    await act(async()=>button('阅读模式').props.onClick());
    assert.equal(editor().props.viewModeEnabled,true);
    assert.equal(button('退出阅读模式').props['aria-pressed'],'true');
    assert.deepEqual(h.state.selectedElementIds,{},'native deselection happens, but is not a shared edit');
    await click();
    assert.equal(focus(),'a');
    assert.deepEqual(highlights(),['a','b','ab'],'only one-hop nodes and their incident edge');
    assert.equal(renderer.root.findByType('svg').findByType('g').props.transform,'translate(40 -60) scale(2)');
    await poll();
    assert.equal(writes,0,'entering/reading must never save native view-mode deselection');
    assert.deepEqual(h.elements,original,'no original colors, versions or geometry changed');
    assert.equal(h.clears,initialClears);
    assert.equal(h.mounts,initialMounts);
    assert.ok(h.changes.slice(initialChanges).every(change=>!change.elements),'highlight does not update native elements');
    await act(async()=>{pointer('pointerdown',{x:230});pointer('pointermove',{x:245});pointer('pointerup',{x:230});});
    assert.equal(focus(),'a','pan that returns to its start is not a click');
    await act(async()=>{pointer('pointerdown',{x:230});pointer('pointercancel',{x:230});pointer('pointerup',{x:230});});
    assert.equal(focus(),'a','cancel is not a click');
    await act(async()=>{pointer('pointerdown',{x:230});pointer('pointerdown',{x:240,id:2,isPrimary:false});pointer('pointerup',{x:240,id:2});pointer('pointerup',{x:230});});
    assert.equal(focus(),'a','pinch is not a click');
    await click({x:230,button:2});assert.equal(focus(),'a','context button is not a click');
    await click({x:230,target:{tagName:'BUTTON'}});assert.equal(focus(),'a','native UI is not a node click');
    await click({x:230});assert.equal(focus(),'b');
    await click({x:900,y:900});assert.equal(focus(),undefined,'blank clears');
    await click({x:750,y:40});assert.equal(focus(),undefined,'invisible frame child cannot be focused');
    await click({x:690,y:40});assert.equal(focus(),'framed');
    const childGroup=renderer.root.findByProps({'data-reading-element':'framed'});
    const clip=renderer.root.findByType('clipPath');
    assert.equal(childGroup.props.clipPath,`url(#${clip.props.id})`,'framed overlay references a world-space clip');
    assert.ok(clip.findByType('path').props.d.startsWith('M 600 0'));
    await act(async()=>h.api.updateScene({appState:{frameRendering:{enabled:true,clip:false}}}));
    await click({x:750,y:40});assert.equal(focus(),'framed');
    assert.equal(renderer.root.findAllByType('clipPath').length,0,'native clipping preference applies to overlay');
    await act(async()=>h.api.updateScene({appState:{frameRendering:{enabled:true,clip:true}}}));
    for(const handler of ['onDropCapture','onDragOverCapture','onPasteCapture','onCutCapture']){
      let prevented=0,stopped=0;
      await act(async()=>canvas().props[handler]({preventDefault(){prevented++;},stopPropagation(){stopped++;}}));
      assert.equal(prevented,1);assert.equal(stopped,1,`${handler} blocks native mutating ingress`);
    }
    // Defense in depth: a native/programmatic insertion cannot become shared
    // geometry even when it bypasses the capture boundary.
    await act(async()=>{
      h.files['reading-file']={id:'reading-file',mimeType:'image/png',dataURL:'data:image/png;base64,iVBORw0KGgo=',created:1};
      h.elements=[...h.elements,{...rect('injected-drop',900),type:'image',fileId:'reading-file'}];rerender();
    });
    assert.deepEqual(h.elements,original);await poll();assert.equal(writes,0);assert.equal(h.clears,initialClears);
    await click();
    const escape={key:'Escape',preventDefault(){this.defaultPrevented=true;},stopPropagation(){}};
    await act(async()=>renderer.root.findByType('section').props.onKeyDownCapture(escape));
    assert.equal(focus(),undefined);assert.equal(editor().props.viewModeEnabled,true,'Escape clears before exiting mode');
    await click();
    // Remote AI edits still arrive in read mode, without restyling their scene.
    server={...server,revision:2,elements:server.elements.map(e=>e.id==='a'?{...e,x:50,version:2}:e)};
    await poll();
    assert.ok(renderer.root.findAllByType('path').some(n=>n.props.d.startsWith('M 50 0')),'remote geometry updates highlight');
    assert.equal(writes,0);
    assert.deepEqual(h.state.selectedElementIds,{},'remote read-mode refresh must not reselect native elements');
    // Adversarial pre-deselection match: the guard must survive both queued native
    // transition phases even if native selection already equals the saved one.
    await act(async()=>h.api.updateScene({appState:{selectedElementIds:{a:true}}}));
    await act(async()=>button('退出阅读模式').props.onClick());
    assert.equal(editor().props.viewModeEnabled,false);
    assert.deepEqual(h.state.selectedElementIds,{a:true},'view exit restores shared native selection without a save');
    await poll();assert.equal(writes,0);
    await openMore();await act(async()=>button('阅读模式').props.onClick());await click({x:80});
    server={...server,revision:3,selectedIds:[],elements:server.elements.map(e=>['a','ab'].includes(e.id)?{...e,isDeleted:true,version:3}:e)};
    await poll();assert.equal(focus(),undefined,'deleting focused node clears local focus');
    await act(async()=>button('退出阅读模式').props.onClick());
    assert.deepEqual(h.state.selectedElementIds,{},'remote deleted selection stays deleted');
    await poll();assert.equal(writes,0);assert.equal(h.clears,initialClears);assert.equal(h.mounts,1);
    assert.deepEqual(Object.keys(server.files),['accepted-file'],'mode exit cannot save rejected orphan cache files');
    await act(async()=>{h.elements=h.elements.map(e=>e.id==='b'?{...e,x:210,version:e.version+1}:e);rerender();});
    await poll();assert.equal(writes,1,'ordinary edits still work after leaving reading');
    assert.deepEqual(Object.keys(server.files),['accepted-file'],'later edits retain accepted undo files but not rejected orphan imports');
    // New board owner must not receive a click started by the previous owner.
    await openMore();await act(async()=>button('阅读模式').props.onClick());
    await act(async()=>pointer('pointerdown',{x:230}));
    props={...props,boardId:'next'};
    await act(async()=>renderer.update(React.createElement(Whiteboard,{...props,key:'next'})));
    await act(async()=>pointer('pointerup',{x:230}));assert.equal(focus(),undefined);assert.equal(editor().props.viewModeEnabled,false);
    assert.equal(h.mounts,2);
    await openMore();await act(async()=>button('阅读模式').props.onClick());await click({x:230});assert.equal(focus(),'b');
    await act(async()=>renderer.update(React.createElement(Whiteboard,{...props,key:'next',visible:false})));
    assert.equal(focus(),undefined,'hidden board cannot leave highlights visible');
    await act(async()=>renderer.update(React.createElement(Whiteboard,{...props,key:'next'})));
    await click({x:230});
    await act(async()=>controller.abort());assert.equal(focus(),undefined);assert.equal(editor().props.viewModeEnabled,false);
    await click({x:230});assert.equal(focus(),undefined,'aborted occurrence cannot regain a highlight');
    assert.equal(writes,1,'only the explicit edit outside reading was saved');assert.ok(reads>1);assert.ok(h.callbacks<200,'native lifecycle remains bounded');
  } finally {
    if(renderer)act(()=>renderer.unmount());
    await unlink(output).catch(error=>{if(error.code!=='ENOENT')throw error;});
    for(const [key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
});
