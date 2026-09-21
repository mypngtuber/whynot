'use strict';
const {Store}=require('../storage/store');
const {PremiereAdapter}=require('../premiere/adapter');
const {GeminiClient}=require('../gemini/client');
const D=require('../core/data');
const W=require('../core/workflow');
const {hashJSON}=require('../core/binary');
const $=id=>document.getElementById(id);
function node(tag,text,cls,parent) {const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;if(parent)parent.appendChild(n);return n;}
function clear(el) {while(el.firstChild)el.removeChild(el.firstChild);}
class App {
  constructor(ppro,uxp) {
    this.uxp=uxp;this.host=new PremiereAdapter(ppro,uxp);this.store=new Store(uxp);
    this.tab='Project';this.busy=false;this.plan=null;this.analysis=null;this.baseline=null;this.current=null;this.locks=[];this.inventory=[];this.materials={};this.captionEdits={};this.modelStatus={};this.revisions=[];this.pending=null;this.captionPage=0;this.stale=false;
  }
  notice(message,error=false) {$('notice').textContent=message;$('notice').className='notice'+(error?' error':'');}
  async run(fn) {
    if(this.busy)return;this.busy=true;this.disable(true);
    try {await fn();} catch(e) {this.notice(e.message||'تعذر تنفيذ العملية.',true);} finally {this.busy=false;this.disable(false);}
  }
  disable(value) {for(const b of document.querySelectorAll('button'))if(b.id!=='cancel-button')b.disabled=value||b.dataset.unavailable==='true';}
  button(parent,text,fn,cls='',unavailable=false) {
    const b=node('button',text,cls,parent);b.dataset.unavailable=String(unavailable);b.disabled=unavailable||this.busy;b.addEventListener('click',()=>this.run(fn));return b;
  }
  card(title,parent=$('content')) {const c=node('div',undefined,'card',parent);if(title)node('h3',title,'',c);return c;}
  field(parent,label,value,type='text') {const l=node('label',label,'',parent),i=node(type==='textarea'?'textarea':'input',undefined,'',parent);if(type!=='textarea')i.type=type;i.value=value;const id='field-'+(++this.fieldId);i.id=id;l.setAttribute('for',id);return i;}
  client() {this.activeClient=new GeminiClient({getKey:()=>this.store.getKey(),model:this.settings.model});return this.activeClient;}
  async init() {
    this.fieldId=0;await this.store.init();this.settings=await this.store.loadSettings();this.revisions=await this.store.revisions();
    this.host.watch(()=>{if(this.baseline){this.stale=true;if(!this.busy)this.notice('تغير المشروع منذ التحليل. راجع الفروق أو أعد التحليل قبل إنشاء نسخة.',true);}});
    $('settings-button').addEventListener('click',()=>this.run(async()=>{this.tab='Settings';this.render();}));
    $('refresh-button').addEventListener('click',()=>this.run(()=>this.inspect()));
    $('start-button').addEventListener('click',()=>this.run(()=>this.prepare()));
    $('cancel-button').addEventListener('click',()=>{this.cancelled=true;if(this.activeClient)this.activeClient.cancel();this.notice('تم طلب الإلغاء. قد يستمر تصدير Premiere الحالي؛ لن تُرسل أجزاء أخرى إلى Gemini.');});
    this.render();await this.run(()=>this.inspect());
  }
  dispose(){if(this.activeClient)this.activeClient.cancel();this.host.dispose();}
  async inspect() {
    this.current=await this.host.read();const s=this.current.data;
    $('sequence-name').textContent=s.name;
    const ratio=s.dimensions.width/s.dimensions.height;
    $('sequence-meta').textContent=`${s.dimensions.width} × ${s.dimensions.height}  /  ${Math.abs(ratio-16/9)<0.02?'16:9':Math.abs(ratio-9/16)<0.02?'9:16':'Original'}  /  ${s.fps.toFixed(3)} FPS  /  ${D.timecode(s.duration)}`;
    $('sequence-state').textContent=`${s.clips.length} مقطع · ${s.tracks.length} مسار`;
    this.notice('تمت قراءة الـSequence الفعلي. التحليل لا يغير الأصل.');this.render();
  }
  async prepare() {
    await this.inspect();
    if(!await this.store.hasKey()){this.tab='Settings';this.render();throw new Error('أضف مفتاح Gemini أولًا. لن نطلب منك Prompt لبدء المونتاج.');}
    if(!this.settings.presetToken){this.tab='Settings';this.render();throw new Error('اختر WAV Audio-only preset من الإعدادات قبل التحليل.');}
    if(this.current.data.clips.some(c=>c.offline!==false))throw new Error('هناك ملفات Offline أو تعذر التحقق من اتصالها. أصلحها قبل التحليل.');
    if(this.current.data.duration>this.settings.maxMinutes*60)throw new Error('مدة المشروع تتجاوز حد التحليل في Settings.');
    if(this.current.data.duration*32000>256*1024*1024)throw new Error('الصوت يتجاوز ميزانية الذاكرة 256MB. يلزم تحليل Sequence أقصر.');
    const baseline=this.current;
    const parts=D.chunks(baseline.data.duration,this.settings.chunkSeconds,this.settings.overlapSeconds);
    const box=$('confirmation');clear(box);box.className='card';
    node('h3','قبل إرسال الصوت','',box);
    node('p',`${D.timecode(baseline.data.duration)} · ${parts.length} جزء بحد أقصى · ${this.settings.model}. يُرسل الصوت والنصوص وأسماء الخامات إلى Gemini بعد موافقتك. لا فيديو كامل ولا مسارات ملفات ولا مفتاح داخل المشروع.`, '',box);
    node('p','التكلفة حسب الموديل والبيانات. قد تتضمن السياسة حفظ البيانات لدى Google. الملفات المخزنة محليًا تتضمن نص الكلام.','muted',box);
    node('div','Alpha: النتيجة خطة + SRT + نسخة بعلامات مراجعة. القص الآلي والكابشن المتحرك وإدراج المؤثرات غير مفعّلة.','warning',box);
    this.button(box,'أوافق — ابدأ التحليل',async()=>{box.className='hidden';await this.begin(baseline);},'primary');
    this.button(box,'إلغاء',async()=>{box.className='hidden';});
  }
  async begin(baseline) {
    await this.host.assertFresh(baseline);this.cancelled=false;
    this.baseline=baseline;this.stale=false;this.plan=null;this.analysis=null;this.pending=null;this.captionEdits={};this.materials={};
    this.locks=this.locks.filter(x=>x.sequenceId===baseline.data.sequenceId);
    const client=this.client();$('progress').className='card';
    try {
      this.inventory=(await this.host.inventory()).items;
      const wav=await this.host.exportAudio(baseline,this.settings.presetToken,()=>client.check(),msg=>{$('progress-label').textContent=msg;});
      this.analysis=await W.analyzeAudio({wav,snapshot:baseline.data,settings:this.settings,client,store:this.store,onProgress:p=>{
        $('progress-label').textContent=p.step==='plan'?'بناء خريطة المحتوى والخطة…':`تحليل الجزء ${p.done+1} من ${p.total}${p.cached?' · من Cache':''}`;
        $('progress-fill').style.width=`${Math.round(p.done/p.total*90)}%`;
      }});
      await this.host.assertFresh(baseline);client.check();
      const context=W.planContext(baseline.data,this.analysis,this.locks,this.inventory);
      const plan=await W.makePlan(client,context,baseline.data,this.locks);
      await this.host.assertFresh(baseline);client.check();this.plan=plan;this.stale=false;
      await this.persist();this.tab='Edit Plan';this.render();
      this.notice('الخطة جاهزة للمراجعة. لم يُقص أي مقطع ولم يتغير الأصل. توقيتات Gemini تحتاج مراجعة بشرية.');
    } finally {$('progress').className='hidden';this.activeClient=null;}
  }
  async persist() {
    if(!this.plan)return;
    await this.store.saveSession({project:this.baseline.data.projectId,sequence:this.baseline.data.sequenceId},{snapshot:this.baseline.data,hash:this.baseline.hash,plan:this.plan,analysis:this.analysis,locks:this.locks,materials:this.materials,captionEdits:this.captionEdits});
  }
  async exportSession() {
    if(!this.plan)throw new Error('أنشئ خطة أولًا.');
    // The exported plan intentionally omits local file paths and persistent file tokens.
    const result=await this.store.exportFile('AstraCut_EditPlan.json',JSON.stringify({version:1,source:this.baseline.data.name,sourceFingerprint:this.baseline.hash,plan:this.plan,transcript:this.analysis.segments,topics:this.analysis.topics,locks:this.locks,materialChoices:this.materials,captionEdits:this.captionEdits,execution:'review-only; cuts/effects not applied'},null,2));
    if(result)this.notice('تم تصدير الخطة والتفريغ. الملف يحتوي محتوى الكلام، لكنه لا يحتوي API Key.');
  }
  render() {
    clear($('tabs'));
    for(const tab of ['Project','Edit Plan','Captions','Effects','Materials','Music','Revisions'])this.button($('tabs'),tab,async()=>{this.tab=tab;this.render();},this.tab===tab?'active':'');
    $('model-label').textContent=`${this.settings.model} · ${this.modelStatus[this.settings.model]||'غير مختبر'}`;
    clear($('content'));
    if(this.tab==='Settings')return this.renderSettings();
    if(this.tab==='Project')return this.renderProject();
    if(this.tab==='Revisions')return this.renderRevisions();
    if(!this.plan){const e=node('div',undefined,'empty',$('content'));node('h3','كل مونتاج يبدأ بفهم المحتوى','',e);node('p','اضغط «قم بمونتاج للمقطع». ستظهر هنا الخطة والكابشن والخامات بعد التحليل.','',e);return;}
    if(this.tab==='Edit Plan')this.renderPlan();
    if(this.tab==='Captions')this.renderCaptions();
    if(this.tab==='Effects')this.renderEffects();
    if(this.tab==='Materials')this.renderMaterials();
    if(this.tab==='Music')this.renderMusic();
  }
  renderProject() {
    const c=this.card('مساحة العمل');
    node('p','إضافة داخل Premiere. تحليل Audio-first، دون نموذج شات عند البداية.','',c);
    if(this.current) {
      for(const track of this.current.data.tracks)node('p',`${track.kind} ${track.index+1} · ${track.name} · ${track.muted?'Muted':'Active'} · القفل: غير قابل للقراءة`,'small',c);
      const s=this.current.data;
      node('p',`${s.markers.length} Markers · ${s.captionTracks} Caption tracks · النسبة الأصلية محفوظة`,'muted',c);
    }
    const l=this.card('حماية نطاق من المونتاج');
    node('p','أدخل الثواني على توقيت الـSequence الأصلي. الحماية تمنع أيضًا القص قبله إذا كان سيحرك توقيته.','muted',l);
    const start=this.field(l,'من (ثواني)',0,'number'),end=this.field(l,'إلى (ثواني)',0,'number');
    this.button(l,'حماية النطاق',async()=>{
      if(!this.current)throw new Error('افتح Sequence.');
      const range={start:Number(start.value),end:Number(end.value),sequenceId:this.current.data.sequenceId};
      if(!D.validRange(range,this.current.data.duration))throw new Error('نطاق غير صالح.');
      this.locks.push(range);await this.persist();this.render();this.notice('تمت حماية النطاق. أعد مراجعة الخطة قبل التنفيذ.');
    });
    this.locks.forEach((range,i)=>{const r=node('div',undefined,'row',l);node('span',`${range.start.toFixed(2)} – ${range.end.toFixed(2)}s`,'ltr',r);this.button(r,'إلغاء الحماية',async()=>{this.locks.splice(i,1);await this.persist();this.render();});});
    node('div','دعم الإنتاج غير مكتمل: القص الآلي، تحريك الكابشن، VFX/SFX على Timeline، التحليل البصري، Crop ذكي، وأقفال العناصر الفردية ليست مفعّلة. لا توجد محاكاة لهذه الوظائف.','warning',c);
    this.button(c,'مقارنة المشروع بالخطة',()=>this.differences());
    this.button(c,'تصدير الخطة والتفريغ',()=>this.exportSession());
  }
  async differences() {
    if(!this.baseline)throw new Error('لا توجد خطة للمقارنة.');
    const now=await this.host.read(),old=this.baseline.data;
    const changed=now.hash!==this.baseline.hash||now.epoch!==this.baseline.epoch;
    this.notice(changed?`Project changed since analysis.\nالمقاطع: ${old.clips.length} → ${now.data.clips.length}\nالمدة: ${D.timecode(old.duration)} → ${D.timecode(now.data.duration)}\nأعد التحليل. سيتم إعادة استخدام أجزاء الصوت المطابقة من Cache.`:'لم يتغير الرسم البنيوي المقروء أو عدّاد أحداث المشروع. لا يشمل هذا إثبات تطابق بايتات الملفات الخارجية.',changed);
  }
  renderPlan() {
    const c=this.card('خطة المونتاج · للمراجعة');node('p',this.plan.summary,'',c);
    const check=D.validatePlan(this.plan,this.baseline.data,this.locks);
    const stats=node('div',undefined,'row',c);
    for(const [value,label] of [[this.plan.cuts.length,'قصّة مقترحة'],[D.timecode(check.duration),'المدة المقترحة'],[this.analysis.segments.length,'جزء تفريغ']]){const s=node('div',undefined,'stat',stats);node('strong',value,'',s);node('span',label,'',s);}
    if(this.stale)node('div','قد تكون الخطة قديمة أو تم الانتقال إلى نسخة أخرى. أعد التحليل على الـSequence المطلوب.','warning',c);
    for(const err of check.errors)node('div',err,'warning',c);
    for(const warning of [...check.warnings,...this.analysis.warnings])node('p',warning,'muted',c);
    const cuts=this.card('قرارات القص');
    if(!this.plan.cuts.length)node('p','لا توجد قصّات مقترحة.','',cuts);
    this.plan.cuts.forEach((cut,i)=>{const r=node('div',undefined,'timeline-item',cuts);node('div',`${D.timecode(cut.start,true)} → ${D.timecode(cut.end,true)} · ${Math.round(cut.confidence*100)}%`,'ltr',r);node('p',cut.reason,'',r);this.button(r,'تجاهل هذه القصّة',async()=>{this.plan.cuts.splice(i,1);await this.persist();this.render();});});
    this.button(c,'مراجعة إنشاء النسخة الآمنة',async()=>this.confirmReview(),'primary');
    this.button(c,'فحص إمكانية تنفيذ القصّات',async()=>{const v=D.validatePlan(this.plan,this.baseline.data,this.locks,true);this.notice(['القص الآلي غير مفعّل في هذه النسخة؛ لا يُنفّذ أي حذف.',...v.errors].join('\n'),true);});
    this.button(c,'تصدير JSON',()=>this.exportSession());
    const suggestions=this.card('اقتراحات AstraCut');
    node('p','كل اقتراح يجهّز تعديلًا للمراجعة فقط.','muted',suggestions);
    for(const text of this.plan.suggestions)this.button(suggestions,text,()=>this.revise(text));
    const chat=this.card('طلب تعديل · اختياري');
    const input=this.field(chat,'اكتب التعديل الذي تريده…','','textarea');
    this.button(chat,'اقتراح تعديل على الخطة',()=>this.revise(input.value),'primary');
    if(this.pending){const p=this.card('تغييرات تنتظر موافقتك');const diff=W.revisionDiff(this.plan,this.pending);node('p',`قصّات جديدة: ${diff.added.length} · قصّات ملغاة: ${diff.removed.length} · المؤثرات: ${diff.effectsBefore} → ${diff.effectsAfter} · الخامات: ${diff.materialsBefore} → ${diff.materialsAfter}`,'',p);node('p',this.pending.summary,'',p);
      for(const cut of diff.added)node('p',`+ ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s: ${cut.reason}`,'',p);
      for(const cut of diff.removed)node('p',`− ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s: ${cut.reason}`,'',p);
      this.button(p,'عرض JSON الكامل',async()=>{const t=node('textarea',undefined,'ltr',p);t.value=JSON.stringify(this.pending,null,2);t.readOnly=true;});
      this.button(p,'اعتماد الخطة المعدلة فقط',async()=>{this.plan=this.pending;this.pending=null;this.captionEdits={};this.materials={};await this.persist();this.render();this.notice('اعتُمدت الخطة. لم يتم تعديل Timeline.');},'primary');
      this.button(p,'تجاهل',async()=>{this.pending=null;this.render();});
    }
  }
  async revise(request) {
    if(!request.trim()||request.length>4000)throw new Error('اكتب تعديلًا من 1 إلى 4000 حرف.');
    const client=this.client(),context=W.planContext(this.baseline.data,this.analysis,this.locks,this.inventory,this.plan);
    const next=D.alignPlan(await client.plan(context,request),this.baseline.data.fps);
    const check=D.validatePlan(next,this.baseline.data,this.locks);
    if(check.errors.length)throw new Error(check.errors.join('\n'));
    this.pending=next;this.tab='Edit Plan';this.render();this.notice('اقتراح تعديل جاهز. راجع الفروق ثم وافق؛ لم يتغير Timeline.');
  }
  confirmReview() {
    const box=$('confirmation');clear(box);box.className='card';
    node('h3','إنشاء نسخة مستقلة بعلامات مراجعة','',box);
    node('p',`${this.plan.cuts.length} اقتراح قص · ${this.plan.effects.length} تأثير · ${this.plan.materials.length} طلب خامة. سيتم نسخ الـSequence وإضافة Markers فقط. لا قص، لا كابشن على Timeline، ولا مؤثرات فعلية.`,'',box);
    const approvedHash=hashJSON(this.plan),baseline=this.baseline;
    this.button(box,'أوافق على النسخ وإضافة العلامات فقط',async()=>{
      if(approvedHash!==hashJSON(this.plan))throw new Error('تغيرت الخطة بعد الموافقة. راجعها مجددًا.');
      box.className='hidden';const record=await this.host.safeReview(baseline,this.plan,this.locks);
      await this.store.revision(record);this.revisions=await this.store.revisions();this.tab='Revisions';this.render();this.notice(`تم إنشاء ${record.name} بعلامات مراجعة فقط. احتفظ بالمشروع عبر Save في Premiere.`);
    },'primary');
    this.button(box,'إلغاء',async()=>{box.className='hidden';});
  }
  renderCaptions() {
    const c=this.card('كابشن من الكلام الأصلي');
    node('p','النص محفوظ كما ورد من Gemini. يمكن تصحيح التفريغ والتوقيت يدويًا. SRT يستخدم توقيت المصدر لأن القصّات لم تُنفذ. لا يُرسل الصوت عند تغيير المظهر.','muted',c);
    const preview=node('div',undefined,'caption-preview',c),sample=node('span',this.analysis.segments[0]?.text||'الكلمة في وقتها المناسب','',preview);
    sample.style.fontSize=Math.round(this.settings.captionSize/2)+'px';sample.style.color=this.settings.captionColor;sample.style.direction=this.settings.captionDirection;
    for(const name of ['Clean','Shorts','Highlight','Kinetic'])this.button(c,name,async()=>{this.settings.captionStyle=name;await this.store.saveSettings(this.settings);this.render();},name===this.settings.captionStyle?'primary':'');
    node('div','المعاينة نصية فقط. SRT لا يحفظ الخط أو اللون أو الحركة. Highlight/Kinetic إعدادات تصميم محفوظة للمستقبل وليست مؤثرات مطبّقة.','warning',c);
    const size=this.field(c,'حجم التصميم (16–120)',this.settings.captionSize,'number'),color=this.field(c,'اللون بصيغة #RRGGBB',this.settings.captionColor),position=this.field(c,'الموضع الرأسي % (15–85)',this.settings.captionPosition,'number');
    this.button(c,this.settings.captionDirection==='rtl'?'الاتجاه: RTL':'الاتجاه: LTR',async()=>{this.settings.captionDirection=this.settings.captionDirection==='rtl'?'ltr':'rtl';await this.store.saveSettings(this.settings);this.render();});
    this.button(c,'حفظ المظهر',async()=>{this.settings=D.settings({...this.settings,captionSize:Number(size.value),captionColor:color.value,captionPosition:Number(position.value)});await this.store.saveSettings(this.settings);this.render();});
    this.button(c,'تصدير SRT بتوقيت المصدر',async()=>{const list=this.analysis.segments.map((s,i)=>({...s,...this.captionEdits[i]}));const f=await this.store.exportFile('AstraCut_Source_Captions.srt',D.srt(list));if(f)this.notice('تم تصدير SRT. استورده إلى Premiere ثم اسحبه للـSequence يدويًا.');},'primary');
    const start=this.captionPage*12,items=this.analysis.segments.slice(start,start+12);
    items.forEach((source,n)=>{const i=start+n,s={...source,...this.captionEdits[i]},card=this.card(`Caption ${i+1}`);const text=this.field(card,'النص',s.text,'textarea'),from=this.field(card,'البداية (ثواني)',s.start,'number'),to=this.field(card,'النهاية (ثواني)',s.end,'number');node('p','الأصل: '+source.text,'muted',card);
      this.button(card,'حفظ التصحيح',async()=>{const edit={text:text.value,start:Number(from.value),end:Number(to.value)};if(!edit.text.trim()||!D.validRange(edit,this.baseline.data.duration))throw new Error('نص أو توقيت غير صالح.');this.captionEdits[i]=edit;await this.persist();this.notice('حُفظ التصحيح مع الاحتفاظ بالنص الأصلي.');});
    });
    const pager=this.card();node('p',`صفحة ${this.captionPage+1} من ${Math.ceil(this.analysis.segments.length/12)}`,'muted',pager);
    this.button(pager,'السابق',async()=>{this.captionPage--;this.render();},'',this.captionPage===0);
    this.button(pager,'التالي',async()=>{this.captionPage++;this.render();},'',start+12>=this.analysis.segments.length);
  }
  renderEffects() {
    const c=this.card('Effect Library · اقتراحات فقط');
    node('p','Punch In / Out · Position Shift · Blur · Shake · Flash · Freeze Frame · Basic Transition','ltr',c);
    node('div','لا يوجد تنفيذ آلي للمؤثرات في Alpha. لا تُقدّم اقتراحات Crop أو Punch In كقرارات مؤكدة دون مراجعة الكادر بصريًا.','warning',c);
    for(const effect of this.plan.effects){const e=this.card(effect.type);node('p',`${effect.start.toFixed(2)}–${effect.end.toFixed(2)}s · ${effect.intensity}`,'ltr',e);node('p',effect.reason,'',e);}
  }
  renderMaterials() {
    const c=this.card('Material Manager');node('p',`${this.inventory.length} خامة في المشروع. التصنيف استدلال من الامتداد والاسم فقط، وليس إثباتًا لتطابق المحتوى أو الترخيص.`,'muted',c);
    this.button(c,'تحديث الخامات',async()=>{this.inventory=(await this.host.inventory()).items;this.render();});
    this.button(c,'استيراد ملف إلى المشروع',async()=>{const name=await this.host.importFile();if(name){this.inventory=(await this.host.inventory()).items;this.render();this.notice(`تم استيراد ${name}. أعد التحليل قبل إنشاء نسخة لأن المشروع تغير.`);}});
    for(const request of this.plan.materials){const card=this.card(request.name);node('p',`${request.type} · ${request.start.toFixed(2)}–${request.end.toFixed(2)}s · ${request.priority} · ${request.required?'Required':'Optional'}`,'ltr',card);node('p',request.reason,'',card);node('p',this.materials[request.id]?.label||'خامة لم تُحدّد بعد','muted',card);
      this.button(card,'Choose from Project',async()=>{const existing=node('div',undefined,'model-list',card);for(const m of this.inventory){this.button(existing,`${m.name} · ${m.offline!==false?'Offline / Unknown':m.type}`,async()=>{if(m.offline!==false)throw new Error('الخامة غير متصلة.');this.materials[request.id]={status:'selected',id:m.id,label:m.name};await this.persist();this.render();},'model-option',m.offline!==false);}});
      this.button(card,'Search Google',async()=>{const result=await this.uxp.shell.openExternal('https://www.google.com/search?q='+encodeURIComponent(request.query));if(result)throw new Error('تعذر فتح البحث.');this.notice('اختر خامة مرخصة للاستعمال المطلوب ثم استوردها بنفسك. لم يتم تنزيل شيء.');});
      this.button(card,'Skip',async()=>{this.materials[request.id]={status:'skipped',label:'تم التخطي باختيار المستخدم'};await this.persist();this.render();});
    }
    if(!this.plan.materials.length)node('p','لم تقترح الخطة خامات ناقصة. لا يعني ذلك أن كل المؤثرات موجودة.','muted',c);
  }
  renderMusic() {
    const c=this.card('Music Direction');node('p',`${this.plan.music.mood} · ${this.plan.music.tempo}`,'',c);
    const prompt=this.field(c,'Music Prompt — انسخه إلى الخدمة التي تختارها',this.plan.music.prompt,'textarea');prompt.readOnly=true;
    node('p','لا توجد Music Generation API. لا يتم توليد أو تنزيل موسيقى. Fade وDucking اقتراحات للمراجعة اليدوية فقط.','muted',c);
    this.button(c,'تصدير Music Prompt',async()=>{await this.store.exportFile('AstraCut_Music_Prompt.txt',this.plan.music.prompt);});
    this.button(c,'اختيار / استيراد موسيقى',async()=>{this.tab='Materials';this.render();});
  }
  renderRevisions() {
    const c=this.card('Revision Manager');node('p','كل نسخة لها Sequence مستقل. العودة تعني فتح نسخة سابقة، لا استبدال المشروع أو الاعتماد على Undo. احفظ ملف Premiere للاحتفاظ بالنسخ.','muted',c);
    for(const r of this.revisions){const card=this.card(r.name);node('p',r.createdAt+' · review-markers','muted',card);
      for(const q of r.quality||[])node('p',`${q.status}: ${q.name}`,q.status==='pass'?'success small':'muted',card);
      this.button(card,'فتح النسخة',async()=>{await this.host.openRevision(r);await this.inspect();});
      this.button(card,'العودة للأصل',async()=>{await this.host.openRevision(r,true);await this.inspect();});
      this.button(card,'تصدير خطة النسخة',async()=>{await this.store.exportFile(r.name+'_plan.json',JSON.stringify(r.plan,null,2));});
    }
    if(!this.revisions.length)node('p','لا توجد نسخ أنشأتها الإضافة بعد.','',c);
  }
  renderSettings() {
    const c=this.card('Gemini API Key');
    node('p','المفتاح يُحفظ في UXP secureStorage، وليس ملفات الإعدادات أو المشروع. لا يوجد تخزين نصّي بديل.','muted',c);
    const key=this.field(c,'API Key','','password');key.setAttribute('autocomplete','off');
    this.button(c,'إظهار / إخفاء',async()=>{key.type=key.type==='password'?'text':'password';});
    this.button(c,'حفظ / تغيير المفتاح',async()=>{await this.store.saveKey(key.value);key.value='';this.notice('تم حفظ المفتاح في التخزين الآمن.');},'primary');
    this.button(c,'حذف المفتاح',async()=>{await this.store.deleteKey();key.value='';this.modelStatus={};this.notice('تم حذف المفتاح.');});
    this.button(c,'اختبار الموديل المحدد (طلب صغير)',async()=>{try{const text=await this.client().test();this.modelStatus[this.settings.model]='اختبار نص ناجح';this.notice(text);}catch(e){this.modelStatus[this.settings.model]='غير متاح / فشل الاختبار';throw e;}finally{this.render();}});
    const m=this.card('Model Settings');node('p','وجود الموديل هنا لا يثبت توفره. لا يوجد تبديل تلقائي إلى موديل آخر.','muted',m);
    const list=node('div',undefined,'model-list',m);
    for(const id of [...new Set([...D.MODELS,...this.settings.customModels])])this.button(list,`${id}${this.settings.model===id?'  — Selected':''} · ${this.modelStatus[id]||'غير مختبر'}`,async()=>{this.settings.model=id;await this.store.saveSettings(this.settings);this.render();},'model-option'+(id===this.settings.model?' selected':''));
    const custom=this.field(m,'Custom Model ID','');custom.className='ltr';
    this.button(m,'+ Add Model',async()=>{const id=D.modelId(custom.value.trim());this.settings=D.settings({...this.settings,customModels:[...new Set([...this.settings.customModels,id])],model:id});await this.store.saveSettings(this.settings);this.render();});
    const a=this.card('Audio & Usage');node('p','جهّز في Premiere Preset للتصدير: Waveform Audio، PCM، Mono، 16000 Hz، 16-bit. احفظه .epr ثم اختره هنا. لا تستخدم فيديو أو تصدير In/Out فقط.','muted',a);
    this.button(a,this.settings.presetToken?'تغيير WAV preset (تم الاختيار)':'اختيار WAV preset (.epr)',async()=>{const f=await this.store.fs.getFileForOpening({types:['epr'],allowMultiple:false});if(f){this.settings.presetToken=await this.store.fs.createPersistentToken(f);await this.store.saveSettings(this.settings);this.render();}});
    const duration=this.field(a,'مدة الجزء بالثواني (30–300)',this.settings.chunkSeconds,'number'),overlap=this.field(a,'Overlap بالثواني (0–30)',this.settings.overlapSeconds,'number'),max=this.field(a,'الحد الأقصى بالدقائق (مع حد ذاكرة 256MB للصوت)',this.settings.maxMinutes,'number');
    this.button(a,this.settings.reuseCache?'Cache: مفعّل':'Cache: معطّل',async()=>{this.settings.reuseCache=!this.settings.reuseCache;await this.store.saveSettings(this.settings);this.render();});
    this.button(a,'حفظ إعدادات التحليل',async()=>{this.settings=D.settings({...this.settings,chunkSeconds:Number(duration.value),overlapSeconds:Number(overlap.value),maxMinutes:Number(max.value)});await this.store.saveSettings(this.settings);this.notice('تم حفظ الإعدادات.');},'primary');
    this.button(a,'مسح Cache',async()=>{await this.store.clearCache();this.notice('تم مسح نتائج أجزاء الصوت. خطط المراجعة والنسخ لم تُحذف.');});
    const info=this.card('حول هذا الإصدار');node('p','AstraCut 0.1.0 · Premiere UXP 25.6+ · Windows / macOS. لا خادم محلي ولا Web App. النسخة Alpha، تحتاج اختبار تحميل وتصدير ونسخ فعلي داخل Premiere.','',info);
    node('p','التنفيذ المتاح: قراءة، تصدير صوت، استيراد خامات، نسخة آمنة وعلامات مراجعة. التنفيذ غير المتاح: قص تلقائي وكابشن متحرك وتأثيرات وCrop وDucking.','warning',info);
  }
}
module.exports={App};
