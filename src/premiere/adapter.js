'use strict';
const {hashJSON,parseWav}=require('../core/binary');
const {validatePlan}=require('../core/data');
const TICKS_PER_SECOND=254016000000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const seconds=t=>{ const n=Number(t.seconds);if(!Number.isFinite(n))throw new Error('تعذر قراءة توقيت Premiere.');return n; };
class PremiereAdapter {
  constructor(ppro,uxp) { this.p=ppro;this.fs=uxp.storage.localFileSystem;this.formats=uxp.storage.formats;this.epoch=0;this.listeners=[];this.watching=false; }
  watch(onChange) {
    if(!this.p.EventManager || !this.p.Constants.ProjectEvent) return false;
    const events=[this.p.Constants.ProjectEvent.DIRTY,this.p.Constants.ProjectEvent.CLOSED,this.p.Constants.ProjectEvent.ACTIVATED,
      this.p.Constants.VideoTrackEvent&&this.p.Constants.VideoTrackEvent.LOCK_CHANGED,
      this.p.Constants.AudioTrackEvent&&this.p.Constants.AudioTrackEvent.LOCK_CHANGED];
    try {
      for(const event of events.filter(x=>x!==undefined)) {
        const handler=()=>{this.epoch++;onChange();};
        this.p.EventManager.addGlobalEventListener(event,handler,false);this.listeners.push([event,handler]);
      }
      this.watching=true;
    } catch(_) {this.watching=false;}
    return this.watching;
  }
  dispose() { for(const [event,handler] of this.listeners)this.p.EventManager.removeGlobalEventListener(event,handler);this.listeners=[]; }
  async active() {
    const project=await this.p.Project.getActiveProject();
    if(!project) throw new Error('افتح مشروعًا داخل Premiere Pro أولًا.');
    const sequence=await project.getActiveSequence();
    if(!sequence) throw new Error('لا يوجد Sequence نشط. افتح Sequence ثم اضغط زر المونتاج.');
    return {project,sequence};
  }
  async snapshot(project,sequence) {
    const epoch=this.epoch;
    const duration=seconds(await sequence.getEndTime()),timebase=Number(await sequence.getTimebase());
    const fps=TICKS_PER_SECOND/timebase,rect=await sequence.getFrameSize();
    if(!(duration>0 && fps>0 && fps<=240 && rect.width>0 && rect.height>0)) throw new Error('الـSequence فارغ أو بياناته غير صالحة.');
    const tracks=[],clips=[],handles=new Map();
    for(const kind of ['Video','Audio']) {
      const count=await sequence[`get${kind}TrackCount`]();
      for(let t=0;t<count;t++) {
        const track=await sequence[`get${kind}Track`](t);
        const items=await track.getTrackItems(this.p.Constants.TrackItemType.CLIP,false);
        const transitions=await track.getTrackItems(this.p.Constants.TrackItemType.TRANSITION,false);
        // 25.6 public AudioTrack/VideoTrack APIs expose LOCK_CHANGED, but no lock getter.
        // Never guess "unlocked" or silently use an undocumented API.
        tracks.push({kind,index:t,name:track.name,locked:null,muted:await track.isMuted(),transitions:transitions.length});
        for(let i=0;i<items.length;i++) {
          const item=items[i],source=await item.getProjectItem(),sourceId=String(await source.getId());
          let media=null,offline=null,path='',nested=true;
          try { media=this.p.ClipProjectItem.cast(source);offline=await media.isOffline();path=await media.getMediaFilePath();nested=await media.isSequence() || await media.isMulticamClip() || await media.isMergedClip(); } catch(_) { /* Unknown media remains blocked for execution. */ }
          const id=`${kind}-${t}-${i}-${sourceId}`;
          clips.push({id,sourceId,kind,track:t,name:await item.getName(),start:seconds(await item.getStartTime()),end:seconds(await item.getEndTime()),
            sourceIn:seconds(await item.getInPoint()),sourceOut:seconds(await item.getOutPoint()),speed:await item.getSpeed(),reversed:!!(await item.isSpeedReversed()),disabled:await item.isDisabled(),offline,path,nested});
          handles.set(id,item);
        }
      }
    }
    const markerCollection=await this.p.Markers.getMarkers(sequence);
    const markers=(await markerCollection.getMarkers([])).map(m=>({name:m.getName(),start:seconds(m.getStart()),duration:seconds(m.getDuration()),type:m.getType()}));
    const data={projectId:String(project.guid),sequenceId:String(sequence.guid),name:sequence.name,duration,fps,timebase,dimensions:{width:rect.width,height:rect.height},tracks,clips,markers,captionTracks:await sequence.getCaptionTrackCount()};
    if(this.epoch!==epoch) throw new Error('تغير المشروع أثناء الفحص. أعد المحاولة بعد إيقاف التعديلات.');
    return {data,hash:hashJSON(data),epoch,project,sequence,handles};
  }
  async read() { const {project,sequence}=await this.active();return this.snapshot(project,sequence); }
  async assertFresh(baseline) {
    const current=await this.read();
    if(current.hash!==baseline.hash || current.epoch!==baseline.epoch) throw new Error('Project changed since analysis. تغير المشروع؛ أعد التحليل أو راجع الفروق.');
    return current;
  }
  transaction(project,label,create,expectedEpoch) {
    if(!this.watching) throw new Error('مراقبة تغيّر المشروع غير متاحة. تم منع الكتابة.');
    let ok=false;
    project.lockedAccess(()=>{
      if(expectedEpoch!==undefined && this.epoch!==expectedEpoch) throw new Error('تغير المشروع قبل التنفيذ مباشرة.');
      ok=project.executeTransaction(compound=>create(compound),label);
    });
    if(!ok) throw new Error('رفض Premiere العملية. لم يتم تأكيد نجاحها.');
  }
  async exportAudio(baseline,presetToken,check=()=>{},onProgress=()=>{}) {
    if(!presetToken) throw new Error('اختر Audio-only WAV preset (.epr) مرة واحدة من الإعدادات.');
    const preset=await this.fs.getEntryForPersistentToken(presetToken);
    const current=await this.assertFresh(baseline);check();
    const ext=await this.p.EncoderManager.getExportFileExtension(current.sequence,preset.nativePath);
    if(String(ext).replace(/^\./,'').toLowerCase()!=='wav') throw new Error('Preset غير مناسب: يجب أن يصدر WAV فقط.');
    const temp=await this.fs.getTemporaryFolder(),file=await temp.createFile(`astracut-${Date.now()}.wav`,{overwrite:false});
    let result;
    try {
      onProgress('تصدير الصوت محليًا عبر Premiere…');
      const manager=this.p.EncoderManager.getManager();
      const accepted=await manager.exportSequence(current.sequence,this.p.Constants.ExportType.IMMEDIATELY,file.nativePath,preset.nativePath,true);
      if(!accepted) throw new Error('رفض Premiere تصدير الصوت. راجع Preset والتصدير اليدوي.');
      let size=0,stable=0;
      for(let i=0;i<600;i++) {
        check();const metadata=await file.getMetadata();
        if(metadata.size>256*1024*1024) throw new Error('ملف الصوت تجاوز ميزانية الذاكرة 256MB. حلّل نطاقًا أقصر في Sequence مستقل.');
        if(metadata.size>44 && metadata.size===size) stable++;else stable=0;
        size=metadata.size;
        if(stable>=2) {
          try { result=parseWav(await file.read({format:this.formats.binary})); }
          catch(e) { if(i>5) throw e; }
          if(result && Math.abs(result.duration-baseline.data.duration)<=Math.max(0.15,1/baseline.data.fps)) break;
          result=null;
        }
        await sleep(2000);
      }
      if(!result) throw new Error('انتهت مهلة تصدير الصوت أو لم تتطابق المدة. لا يُرسل ملف غير مكتمل.');
      await this.assertFresh(baseline);check();return result;
    } finally {
      // Export cannot currently be cancelled via the documented encoder API.
      // Deletion may fail while Premiere holds the file; temp storage is host-managed.
      try {await file.delete();}catch(_) { /* No media path or secret is logged. */ }
    }
  }
  async inventory() {
    const {project}=await this.active(),out=[],handles=new Map(),seen=new Set();
    const walk=async(folder,depth)=>{
      if(depth>32) throw new Error('Project bin nesting أعمق من الحد الآمن.');
      for(const item of await folder.getItems()) {
        if(out.length>10000) throw new Error('أكثر من 10000 خامة؛ قلّل نطاق المشروع.');
        const id=String(await item.getId());if(seen.has(id))continue;seen.add(id);
        let child;try{child=this.p.FolderItem.cast(item);}catch(_){}
        if(child) {await walk(child,depth+1);continue;}
        try {
          const clip=this.p.ClipProjectItem.cast(item),path=await clip.getMediaFilePath(),name=item.name;
          const ext=path.split('.').pop().toLowerCase();
          const type=/^(wav|mp3|aif|aiff|m4a|aac)$/.test(ext)?(/whoosh|impact|sfx|pop|click/i.test(name)?'SFX':'Music'):/^(png|jpg|jpeg|webp|tif|psd)$/.test(ext)?'Image':ext==='mogrt'?'Graphic':'B-roll';
          out.push({id,name,type,path,offline:await clip.isOffline()});handles.set(id,item);
        } catch(_) {out.push({id,name:item.name,type:'Unknown',offline:null});}
      }
    };
    await walk(await project.getRootItem(),0);return {items:out,handles};
  }
  async importFile() {
    const file=await this.fs.getFileForOpening({allowMultiple:false,types:['wav','mp3','aif','aiff','m4a','mp4','mov','mxf','png','jpg','jpeg','psd','mogrt','srt']});
    if(!file)return null;
    const {project}=await this.active();
    const ok=await project.importFiles([file.nativePath],false,await project.getRootItem(),false);
    if(!ok)throw new Error('لم يؤكد Premiere استيراد الملف.');
    return file.name;
  }
  async safeReview(baseline,plan,locks) {
    const validation=validatePlan(plan,baseline.data,locks);
    if(validation.errors.length)throw new Error(validation.errors.join('\n'));
    const current=await this.assertFresh(baseline),p=current.project;
    const before=await p.getSequences(),ids=new Set(before.map(s=>String(s.guid)));
    // No original in/out points, source project items, or original clip objects are mutated.
    this.transaction(p,'AstraCut: create safe review copy',c=>c.addAction(current.sequence.createCloneAction()),current.epoch);
    const created=(await p.getSequences()).filter(s=>!ids.has(String(s.guid)));
    if(created.length!==1)throw new Error('تعذر تحديد النسخة الجديدة بأمان. لم تُنفذ أي قصّات؛ افحص Project panel.');
    const copy=created[0];
    try {
      const sourceAfter=await this.snapshot(p,current.sequence);
      if(sourceAfter.hash!==baseline.hash)throw new Error('تغير الأصل أثناء إنشاء النسخة؛ تم إيقاف الخطة.');
      const copied=await this.snapshot(p,copy);
      if(hashJSON(copied.data.clips)!==hashJSON(baseline.data.clips) || hashJSON(copied.data.dimensions)!==hashJSON(baseline.data.dimensions))throw new Error('لم تتطابق النسخة مع الأصل.');
      let n=1,name;
      do{name=`${baseline.data.name}__AstraCut_v${String(n++).padStart(3,'0')}`;}while(before.some(s=>s.name===name));
      const pi=await copy.getProjectItem(),markers=await this.p.Markers.getMarkers(copy);
      const notes=[...plan.cuts.map(c=>({...c,label:'CUT PROPOSAL'})),...plan.effects.map(e=>({...e,label:e.type})),...plan.materials.map(m=>({...m,label:`MATERIAL: ${m.name}`}))];
      this.transaction(p,'AstraCut: annotate review copy',compound=>{
        compound.addAction(pi.createSetNameAction(name));
        for(const n of notes)compound.addAction(markers.createAddMarkerAction(n.label,'Comment',this.p.TickTime.createWithSeconds(n.start),this.p.TickTime.createWithSeconds(n.end-n.start),n.reason));
      },this.epoch);
      const original=await this.snapshot(p,current.sequence),after=await this.snapshot(p,copy);
      if(original.hash!==baseline.hash)throw new Error('فحص الجودة: تغير الأصل. توقف وراجع المشروع.');
      if(hashJSON(after.data.clips)!==hashJSON(baseline.data.clips))throw new Error('فحص الجودة: المقاطع في النسخة لا تطابق الأصل.');
      if(after.data.markers.length!==baseline.data.markers.length+notes.length)throw new Error('فحص الجودة: عدد العلامات لا يطابق الخطة.');
      if(!await p.openSequence(copy))throw new Error('تم إنشاء النسخة لكن تعذر فتحها. افتحها من Project panel.');
      return {projectId:baseline.data.projectId,sourceId:baseline.data.sequenceId,sequenceId:String(copy.guid),name,createdAt:new Date().toISOString(),kind:'review-markers',planHash:hashJSON(plan),plan,sourceHash:baseline.hash,
        quality:[{name:'الأصل لم يتغير (بنية المقاطع والتوقيتات المقروءة)',status:'pass'},{name:'النسخة تحافظ على أبعاد وتوقيتات المقاطع',status:'pass'},{name:'عدد علامات المراجعة يطابق الخطة',status:'pass'},
          {name:'Offline media',status:baseline.data.clips.every(c=>c.offline===false)?'pass':'warning'},
          {name:'القص والكابشن والمؤثرات على Timeline: لم تُنفّذ',status:'not-run'},{name:'أقفال المسارات ومزامنة المحتوى الفعلية وتطابق المؤثرات: غير قابل للتحقق الكامل',status:'warning'}]};
    } catch(e) {
      try{await p.openSequence(current.sequence);}catch(_){}
      throw new Error(`${e.message}\nأُوقفت العمليات. الأصل لم يكن هدفًا للتعديل؛ قد تبقى نسخة جزئية في Project panel للفحص.`);
    }
  }
  async openRevision(record,original=false) {
    const {project}=await this.active();
    if(String(project.guid)!==record.projectId)throw new Error('هذه النسخة تخص مشروعًا آخر.');
    const wanted=original?record.sourceId:record.sequenceId;
    const sequence=(await project.getSequences()).find(s=>String(s.guid)===wanted);
    if(!sequence)throw new Error('النسخة غير موجودة؛ ربما حُذفت من المشروع.');
    if(!await project.openSequence(sequence))throw new Error('تعذر فتح النسخة.');
  }
}
module.exports={PremiereAdapter,TICKS_PER_SECOND};
