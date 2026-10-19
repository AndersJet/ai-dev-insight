import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectionPresentation,overviewControls} from '../src/overview-state.js';

const verified={canPass:true,readOnly:false,finalizing:false,checks:{hook:true,account:true},confirmed:{global:true,local:true,session:false}};

test('Hook summary uses semantic status and remains independent from displayed detail text',()=>{
  for(const [hookPhase,brief] of [['ready','文件就绪'],['installed','文件就绪'],['failed','需处理'],['checking','检查中'],['downloading','下载中'],['pending','等待检查']] as const){
    assert.equal(overviewControls({hookPhase}).hookBrief,brief);
    assert.equal(overviewControls({hookPhase}).attention,hookPhase==='failed');
  }
  assert.equal(overviewControls({hookPhase:'ready',remoteError:'synthetic'}).attention,true);
});

test('repair, readonly verification and update guards compose without rendering order',()=>{
  for(const busy of [false,true])for(const readOnly of [false,true])for(const updating of [false,true]){
    const state={verification:{...verified,readOnly},recovery:{busy,blocked:false},updates:{phase:updating?'installing':'ready'}};
    const {disabled}=overviewControls(state);
    assert.equal(disabled['verification-pass'],busy||readOnly);
    assert.equal(disabled['verification-fail'],busy||readOnly);
    assert.equal(disabled['verification-check'],busy);
    assert.equal(disabled['verification-platform'],busy);
    assert.equal(disabled['update-apply'],busy||updating);
    assert.equal(disabled['update-check'],updating);
    assert.equal(disabled['verification-session'],busy||readOnly);
    assert.equal(disabled['verification-global'],true,'confirmed settings stay confirmed');
  }
});

test('ending repair restores each action from its current prerequisites rather than its prior DOM value',()=>{
  const before=overviewControls({verification:verified,recovery:{busy:true,blocked:true},updates:{phase:'installing'}});
  const after=overviewControls({verification:{...verified,checks:{hook:false,account:true}},recovery:{busy:false,blocked:true},updates:{phase:'ready'}});
  assert.equal(before.disabled['verification-check'],true);assert.equal(after.disabled['verification-check'],false);
  assert.equal(after.disabled.repair,true);assert.equal(after.disabled['verification-session'],true);
  assert.equal(after.disabled['update-apply'],false);assert.equal(after.attention,true);
  assert.equal(overviewControls({verification:{...verified,finalizing:true}}).disabled['verification-start'],true);
});

test('collection presentation preserves separate file, enablement and delivery evidence',()=>{
  const base={local:true,remote:true,origin:'http://example.invalid',bound:true,validated:true,enabled:true,runtimeAllowed:true,trusted:true,gitState:'active',hook:{state:'ready' as const,profile:'synthetic'},guideConfirmed:true,canConfirm:true,remoteAvailable:true,remoteError:'',transport:'accepted' as const,error:'',stale:false};
  const shown=collectionPresentation(base);
  assert.equal(shown.hookPhase,'ready');assert.match(shown.hook,/运行待验证/);assert.match(shown.hook,/保存待核对/);
  assert.equal(collectionPresentation({...base,enabled:false}).git,'远端已暂停');
  assert.equal(collectionPresentation({...base,trusted:false}).git,'待工作区信任');
  assert.equal(collectionPresentation({...base,remoteAvailable:false}).badge,'远端待接入');
  assert.equal(collectionPresentation({...base,hook:{state:'failed',reason:'remote_hook_window_conflict',profile:'synthetic'}}).hookPhase,'failed');
});
