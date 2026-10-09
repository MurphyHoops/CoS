import {describe,expect,it} from 'vitest';
import {sendNativeWebFirstNewChat} from '../../src/main/next/web-first/native-web-input.js';
const chat='22222222-2222-4222-8222-222222222222';
function page(opts?:{start?:string;neverNavigate?:boolean;draft?:string;busy?:boolean}){
  let url=opts?.start??'https://chatgpt.com/',userText='';
  let sends=0;
  const events:string[]=[];
  const contents={
    getURL:()=>url,
    executeJavaScript:async(script:string)=>{
      if(script.includes('userCount:document.querySelectorAll'))return {
        x:90,y:50,visible:true,draft:userText||opts?.draft||'',streaming:opts?.busy??false,userCount:0};
      return userText?[userText]:[];
    },
    debugger:{
      attach:()=>{events.push('attach');},
      isAttached:()=>true,
      detach:()=>{events.push('detach');},
      sendCommand:async(name:string,args:{type?:string;text?:string})=>{
        events.push(name+':'+(args.type??''));
        if(name==='Input.insertText')userText=args.text??'';
        if(name==='Input.dispatchKeyEvent'&&args.type==='keyDown'){
          sends++;
          if(!opts?.neverNavigate)url='https://chatgpt.com/c/'+chat;
        }
      }
    }
  };
  return {contents,sends:()=>sends,events};
}
describe('ChatGPT homepage native first Goal turn',()=>{
  it('submits once through webpage input and binds only a real /c route + exact user text',async()=>{
    const p=page();
    const result=await sendNativeWebFirstNewChat(p.contents as never,'CoS first turn');
    expect(result).toMatchObject({proved:true,conversationId:chat});
    expect(result.proof).toMatch(/^dom:[a-f0-9]{64}$/);
    expect(p.sends()).toBe(1);
    expect(p.events).toContain('Input.insertText:');
  });
  it('does not send if origin is wrong, draft exists or model busy',async()=>{
    for(const params of [{start:'https://evilchatgpt.com/'},{draft:'existing text'},{busy:true}]){
      const p=page(params);
      await expect(sendNativeWebFirstNewChat(p.contents as never,'No send')).rejects.toThrow();
      expect(p.sends()).toBe(0);
    }
  });
});
