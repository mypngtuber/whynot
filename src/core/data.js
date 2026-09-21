'use strict';
const MODELS = Object.freeze([
  'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
  'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite'
]);
const DEFAULTS = Object.freeze({ model: 'gemini-2.5-flash', customModels: [],
  chunkSeconds: 120, overlapSeconds: 8, maxMinutes: 180, reuseCache: true,
  captionStyle: 'Clean', captionSize: 48, captionColor: '#ffffff',
  captionPosition: 78, captionDirection: 'rtl', maxWords: 8, presetToken: '' });
function modelId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,119}$/.test(value))
    throw new Error('Model ID غير صالح. استخدم الاسم فقط دون رابط أو مسار.');
  return value;
}
function settings(input = {}) {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (input[k] !== undefined) s[k] = input[k];
  modelId(s.model);
  if (!Array.isArray(s.customModels) || s.customModels.length > 50) throw new Error('قائمة الموديلات غير صالحة.');
  s.customModels = [...new Set(s.customModels.map(modelId))];
  for (const [k, min, max] of [['chunkSeconds',30,300],['overlapSeconds',0,30],['maxMinutes',1,1440],['captionSize',16,120],['captionPosition',15,85],['maxWords',2,20]]) {
    if (!Number.isFinite(s[k]) || s[k] < min || s[k] > max) throw new Error(`إعداد غير صالح: ${k}`);
  }
  if (s.overlapSeconds >= s.chunkSeconds / 2) throw new Error('Overlap كبير جدًا.');
  if (typeof s.reuseCache !== 'boolean' || typeof s.presetToken !== 'string') throw new Error('إعدادات غير صالحة.');
  if (!['Clean','Shorts','Highlight','Kinetic'].includes(s.captionStyle) || !['rtl','ltr'].includes(s.captionDirection) || !/^#[0-9a-f]{6}$/i.test(s.captionColor)) throw new Error('إعدادات كابشن غير صالحة.');
  return s;
}
const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };
const array = (items) => ({ type: 'array', items });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const range = { start: N, end: N };
const cutSchema = object({ ...range, reason: S, confidence: N });
const analysisSchema = object({
  segments: array(object({ ...range, text: S, speaker: S })),
  topics: array(object({ ...range, title: S, summary: S })),
  candidates: array(cutSchema), summary: S
});
const materialSchema = object({ id: S, type: {type:'string',enum:['B-roll','SFX','VFX','Music','Image','Graphic']},
  name: S, ...range, reason: S, priority: {type:'string',enum:['high','medium','low']}, required: B, query: S });
const planSchema = object({ summary: S, cuts: array(cutSchema),
  effects: array(object({ ...range, type: {type:'string',enum:['Punch In','Punch Out','Position Shift','Blur','Shake','Flash','Freeze Frame','Basic Transition']}, reason: S, intensity: {type:'string',enum:['low','medium','high']} })),
  materials: array(materialSchema), music: object({ mood: S, tempo: S, prompt: S }), suggestions: array(S), warnings: array(S) });
// Validate again locally; JSON mode alone is not a security boundary.
function validateSchema(value, schema, path = '$', depth = 0) {
  if (depth > 16) throw new Error('JSON عميق أكثر من اللازم.');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: object مطلوب`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path}: حقل غير مسموح ${key}`);
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}: حقل ناقص ${key}`);
      validateSchema(value[key], schema.properties[key], `${path}.${key}`, depth + 1);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 20000) throw new Error(`${path}: array غير صالح`);
    value.forEach((v, i) => validateSchema(v, schema.items, `${path}[${i}]`, depth + 1));
  } else if (typeof value !== schema.type || (schema.type === 'number' && !Number.isFinite(value)) ||
    (schema.type === 'string' && value.length > 12000)) throw new Error(`${path}: قيمة غير صالحة`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: قيمة غير مدعومة`);
  return value;
}
function validRange(r, duration) { return Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start && r.end <= duration + 0.001; }
function validateAnalysis(a, duration) {
  validateSchema(a, analysisSchema);
  for (const list of [a.segments,a.topics,a.candidates]) for (const r of list)
    if (!validRange(r,duration)) throw new Error('توقيت تحليل خارج حدود جزء الصوت.');
  let previous = 0;
  for (const s of a.segments) {
    if (s.start < previous || !s.text.trim()) throw new Error('Transcript غير مرتب أو فارغ.');
    previous = s.start;
  }
  for (const c of a.candidates) if (c.confidence < 0 || c.confidence > 1) throw new Error('Confidence غير صالح.');
  return a;
}
function chunks(duration, length, overlap) {
  if (!(duration > 0 && length > 0 && overlap >= 0 && overlap < length)) throw new Error('تقسيم صوت غير صالح.');
  const result = [];
  for (let start = 0; start < duration; start += length - overlap) {
    const end = Math.min(duration, start + length);
    result.push({start,end});
    if (end === duration) break;
  }
  return result;
}
function mergeAnalyses(parts) {
  const segments = [], topics = [], candidates = [];
  parts.forEach((p,i) => {
    const left = i ? (parts[i-1].end + p.start) / 2 : p.start;
    const right = i < parts.length-1 ? (p.end + parts[i+1].start) / 2 : p.end;
    for (const [key,out] of [['segments',segments],['topics',topics],['candidates',candidates]]) {
      for (const item of p.analysis[key]) {
        const start = p.start + item.start, end = p.start + item.end, mid = (start + end) / 2;
        if (mid >= left && mid < right) out.push({...item,start,end});
      }
    }
  });
  segments.sort((a,b)=>a.start-b.start);
  // Do not silently trim overlapping transcript or rewrite negations/names.
  const warnings = [];
  for (let i=1;i<segments.length;i++) if (segments[i].start < segments[i-1].end)
    warnings.push(`راجع تداخل التفريغ عند ${segments[i].start.toFixed(2)}s`);
  return {segments,topics,candidates,warnings};
}
function validatePlan(plan, snapshot, locks = [], execution = false) {
  validateSchema(plan, planSchema);
  const errors = [], warnings = [...plan.warnings];
  if (plan.cuts.length > 500 || plan.materials.length > 300 || plan.effects.length > 300) errors.push('الخطة أكبر من حدود التنفيذ الآمن.');
  let last = -1;
  const fps = snapshot.fps;
  for (const c of plan.cuts) {
    if (!validRange(c,snapshot.duration) || c.start < last) errors.push('قصّات متداخلة أو غير مرتبة أو خارج الحدود.');
    if (c.confidence < 0 || c.confidence > 1) errors.push('درجة الثقة خارج الحدود.');
    if ([c.start,c.end].some(t => Math.abs(t*fps-Math.round(t*fps)) > 0.001)) errors.push('القصّات يجب أن تقع على Frame boundaries.');
    last = c.end;
    // Ripple changes later protected regions even if the deleted interval does not overlap.
    if (locks.some(l => l.end > c.start)) errors.push('القص أو تحريك التوقيت سيؤثر على منطقة محمية.');
    if (execution) {
      const affected = snapshot.clips.filter(x => x.start < c.end-0.0001 && x.end > c.start+0.0001);
      if (!affected.length || affected.some(x => x.start < c.start-0.0001 || x.end > c.end+0.0001)) errors.push('التنفيذ يدعم حذف مقاطع كاملة فقط عند حدود مشتركة. القص داخل المقطع غير مدعوم.');
      const coverage = affected.map(x=>({start:x.start,end:x.end})).sort((a,b)=>a.start-b.start);
      let cursor = c.start;
      for (const x of coverage) { if (x.start > cursor+0.0001) break; cursor = Math.max(cursor,x.end); }
      if (cursor < c.end-0.0001) errors.push('نطاق الحذف يحتوي فجوة؛ Ripple غير آمن.');
    }
  }
  for (const r of [...plan.materials,...plan.effects]) if (!validRange(r,snapshot.duration)) errors.push('توقيت خامة أو تأثير غير صالح.');
  if (new Set(plan.materials.map(x=>x.id)).size !== plan.materials.length || plan.materials.some(x=>!/^[a-zA-Z0-9_-]{1,64}$/.test(x.id))) errors.push('معرّفات الخامات غير صالحة أو مكررة.');
  const removed = plan.cuts.reduce((s,c)=>s+c.end-c.start,0);
  if (removed >= snapshot.duration - 1/fps) errors.push('لا يمكن حذف الـSequence بالكامل.');
  if (execution && plan.cuts.length) {
    if (snapshot.tracks.some(t=>t.locked !== false)) errors.push('لا يمكن إثبات أن المسارات غير مقفلة في هذا الإصدار؛ تم منع القص.');
    if (snapshot.clips.some(c=>c.offline !== false || c.speed !== 1 || c.reversed || c.nested)) errors.push('Offline أو Nested أو Speed غير عادي: القص الآلي غير مدعوم.');
    if (snapshot.tracks.some(t=>t.transitions !== 0) || snapshot.captionTracks > 0) errors.push('Transitions أو Caption tracks موجودة؛ يلزم التعامل اليدوي.');
    if (snapshot.markers.length) errors.push('توجد Markers أصلية؛ تحريكها مع Ripple غير مدعوم في هذه النسخة.');
  }
  if (plan.effects.length) warnings.push('VFX: اقتراحات فقط؛ التطبيق الآلي غير مفعّل.');
  if (plan.materials.length) warnings.push('اختيار الخامات لا يعني إدراجها تلقائيًا في Timeline.');
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)],duration:snapshot.duration-removed};
}
function alignPlan(plan,fps) {
  const copy=JSON.parse(JSON.stringify(plan));
  copy.cuts.forEach(c=>{c.start=Math.round(c.start*fps)/fps;c.end=Math.round(c.end*fps)/fps;});
  return copy;
}
function mapTime(time,cuts) {
  let removed=0;
  for (const c of cuts) { if(time < c.start) break; removed += Math.min(time,c.end)-c.start; }
  return time-removed;
}
function captions(segments,cuts=[]) {
  const result=[];
  for (let i=0;i<segments.length;i++) {
    const s=segments[i];
    const intersect=cuts.filter(c=>c.start<s.end && c.end>s.start);
    if(intersect.some(c=>c.start<=s.start && c.end>=s.end)) continue;
    // A partially cut phrase must be resegmented by a human, never guessed.
    if(intersect.length) { result.push({...s,id:`caption-${i}`,blocked:true}); continue; }
    result.push({...s,id:`caption-${i}`,start:mapTime(s.start,cuts),end:mapTime(s.end,cuts),blocked:false});
  }
  return result;
}
function timecode(seconds,ms=false) {
  const total=Math.round(seconds*(ms?1000:1));
  const whole=ms?Math.floor(total/1000):total;
  return [Math.floor(whole/3600),Math.floor(whole/60)%60,whole%60].map(n=>String(n).padStart(2,'0')).join(':')+(ms?','+String(total%1000).padStart(3,'0'):'');
}
function srt(items) {
  let last=0;
  for(const c of items) {
    if(c.blocked || !validRange(c,Number.MAX_SAFE_INTEGER) || c.start<last || !c.text.trim() || c.text.includes('-->')) throw new Error('راجع توقيتات الكابشن المتداخلة أو الجمل المقطوعة قبل تصدير SRT.');
    last=c.end;
  }
  return '\ufeff'+items.map((c,i)=>`${i+1}\n${timecode(c.start,true)} --> ${timecode(c.end,true)}\n${c.text.replace(/\r/g,'').replace(/\n\s*\n/g,'\n')}\n`).join('\n');
}
module.exports={MODELS,DEFAULTS,modelId,settings,analysisSchema,planSchema,validateSchema,validateAnalysis,validRange,chunks,mergeAnalyses,validatePlan,alignPlan,mapTime,captions,srt,timecode,object,array,S};
