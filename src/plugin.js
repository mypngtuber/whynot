'use strict';
// Host modules intentionally required directly: this is not a browser application.
try {
  const uxp=require('uxp');
  const ppro=require('premierepro');
  const {App}=require('./ui/app');
  let app;
  const start=()=>{if(!app){app=new App(ppro,uxp);app.init().catch(e=>{document.getElementById('notice').textContent='تعذر بدء AstraCut: '+e.message;});}};
  uxp.entrypoints.setup({panels:{astracut:{show:start}},plugin:{destroy(){if(app)app.dispose();}}});
  start();
} catch (_) {
  document.getElementById('notice').textContent='AstraCut إضافة UXP فقط. افتحها داخل Premiere Pro 25.6+ باستخدام UXP Developer Tool أو ثبّت CCX. لا يوجد وضع ويب أو مشروع تجريبي.';
  document.getElementById('start-button').disabled=true;
}
