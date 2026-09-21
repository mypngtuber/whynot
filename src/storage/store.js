'use strict';
const {settings}=require('../core/data');
const {hashJSON}=require('../core/binary');
class Store {
  constructor(uxp) { this.uxp=uxp; this.fs=uxp.storage.localFileSystem; this.secure=uxp.storage.secureStorage; }
  async init() { this.root=await this.fs.getDataFolder(); this.cache=await this.root.createFolder('cache'); }
  async read(folder,name) {
    let entry;
    try { entry=await folder.getEntry(name); } catch (_) { return null; }
    const text=await entry.read();
    if(text.length>32*1024*1024) throw new Error('ملف التخزين كبير جدًا.');
    const data=JSON.parse(text);
    if(data.version!==1 || hashJSON(data.payload)!==data.checksum) throw new Error('ملف التخزين تالف.');
    return data.payload;
  }
  async write(folder,name,payload) {
    const file=await folder.createFile(name,{overwrite:true});
    await file.write(JSON.stringify({version:1,checksum:hashJSON(payload),payload}));
  }
  async loadSettings() { return settings(await this.read(this.root,'settings.json')||{}); }
  async saveSettings(s) { await this.write(this.root,'settings.json',settings(s)); }
  async getKey() {
    try { const value=await this.secure.getItem('gemini-api-key');return new TextDecoder().decode(value); }
    catch (_) { throw new Error('أضف Gemini API Key من الإعدادات. إن تعذر فك التخزين الآمن، أعد حفظ المفتاح.'); }
  }
  async hasKey() { try { return !!(await this.getKey()); } catch (_) { return false; } }
  async saveKey(key) {
    if(typeof key!=='string' || key.trim().length<16 || /\s/.test(key.trim())) throw new Error('مفتاح غير صالح.');
    await this.secure.setItem('gemini-api-key',key.trim());
  }
  async deleteKey() { await this.secure.removeItem('gemini-api-key'); }
  cacheName(key) { if(!/^[a-f0-9]{64}$/.test(key)) throw new Error('Cache key غير صالح.');return key+'.json'; }
  async getCache(key) { try { return await this.read(this.cache,this.cacheName(key)); } catch (_) { return null; } }
  async putCache(key,value) {
    const entries=await this.cache.getEntries();
    if(entries.length>=1000) throw new Error('Cache ممتلئ (1000 جزء). امسحه من الإعدادات قبل المتابعة.');
    await this.write(this.cache,this.cacheName(key),value);
  }
  async clearCache() { for(const f of await this.cache.getEntries()) await f.delete(); }
  async saveSession(id,payload) { await this.write(this.root,`session-${hashJSON(id)}.json`,payload); }
  async getSession(id) { return this.read(this.root,`session-${hashJSON(id)}.json`); }
  async revisions() { return await this.read(this.root,'revisions.json')||[]; }
  async revision(value) {
    const list=await this.revisions();list.unshift(value);
    await this.write(this.root,'revisions.json',list.slice(0,200));
  }
  async exportFile(name,text) {
    const file=await this.fs.getFileForSaving(name,{types:[name.split('.').pop()]});
    if(!file) return null;
    await file.write(text);return file;
  }
}
module.exports={Store};
