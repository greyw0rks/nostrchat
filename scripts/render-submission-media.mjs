import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const proof = JSON.parse(readFileSync('docs/evidence/nostrchat-browser-regtest.json','utf8'));
assert.equal(proof.status,'passed'); assert.equal(proof.network,'regtest'); assert.equal(proof.monetaryValue,false);
assert.equal(proof.transaction.amountSats,100); assert.equal(proof.transaction.payerAndReceiverVerified,true);
const source = resolve(proof.artifactDirectory);
const output = resolve('docs/nostrchat/submission/media'); mkdirSync(output,{recursive:true});
const font = readFileSync('node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2').toString('base64');
const items = [
  ['00-thumbnail.png','Private conversations.\nVerified Lightning.','Messages, invoices and receipts in one place.','desktop-landing.png'],
  ['01-private-messages.png','A private conversation.','Actual encrypted delivery between two generated builder identities.','desktop-conversation.png'],
  ['02-invoice.png','Request payment in context.','A real 100-sat invoice from the receiving LND regtest wallet.','desktop-invoice.png'],
  ['03-payment-review.png','Review before you pay.','Amount, network and wallet are fixed before explicit confirmation.','phone-payment-review.png'],
  ['04-verified-receipt.png','A receipt you can verify.','The payer and receiver checked the same matching payment proof.','desktop-verified-receipt.png'],
  ['05-phone-messages.png','Built for your phone.','The same private conversation on a touch interface.','phone-conversation.png'],
  ['06-recovery.png','Pick up the same conversation.','Same-key backup unlock restores the contact and encrypted history.','phone-360-restored-conversation.png']
];
const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page = await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:1});
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const assets=[];
try {
  for (const [file,title,detail,capture] of items) {
    const original=readFileSync(resolve(source,capture));
    const portrait=capture.startsWith('phone');
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>@font-face{font-family:Manrope;src:url(data:font/woff2;base64,${font});font-weight:200 800}*{box-sizing:border-box}body{margin:0;width:1500px;height:1000px;background:#f8f7f1;color:#174f47;font-family:Manrope,sans-serif;overflow:hidden}.head{position:absolute;left:70px;top:48px;right:70px}.brand{font-size:27px;font-weight:800;letter-spacing:-1px}.dot{color:#bd725b}h1{font-size:56px;line-height:1.12;letter-spacing:-2.7px;margin:22px 0 14px;white-space:pre-line;max-width:1330px}p{font-size:23px;line-height:1.45;margin:0;color:#596b63}.frame{position:absolute;left:${portrait?935:70}px;top:${portrait?104:file==="00-thumbnail.png"?315:275}px;width:${portrait?455:1360}px;height:${portrait?780:file==="00-thumbnail.png"?590:630}px;background:#e5ece2;border:1px solid #ccdacb;border-radius:26px;padding:18px;display:flex;align-items:center;justify-content:center;overflow:hidden}.capture{max-width:100%;max-height:100%;object-fit:contain;border-radius:13px;box-shadow:0 14px 35px #153f3925}.foot{position:absolute;left:70px;right:70px;bottom:38px;border-top:1px solid #cad7ca;padding-top:19px;font-size:20px;display:flex;justify-content:space-between;color:#4e675d}.phone .head{right:625px;top:84px}.phone h1{font-size:66px;max-width:720px;margin-top:56px}.phone p{max-width:650px;line-height:1.65}.pill{display:inline-block;border:1px solid #cddacb;background:#eef2e8;color:#39594c;border-radius:10px;padding:11px 17px;font-size:19px;font-weight:700;margin-top:34px}</style><body class="${portrait?'phone':''}"><div class="head"><div class="brand">nostrchat<span class="dot">.</span></div><h1>${title}</h1><p>${detail}</p>${portrait?'<div class="pill">100-sat private regtest exercise</div>':''}</div><div class="frame"><img class="capture" src="data:image/png;base64,${original.toString('base64')}" alt="Actual NostrChat builder test screenshot"></div><div class="foot"><span>Generated builder identities · Private relay</span><span>Regtest sats have no monetary value</span></div>`);
    await page.evaluate(()=>document.fonts.ready); await page.locator('.capture').evaluate(image=>image.decode());
    const overflow=await page.locator('.head').evaluate(element=>element.scrollWidth>element.clientWidth);assert.equal(overflow,false);
    await page.screenshot({path:resolve(output,file)});
    const bytes=readFileSync(resolve(output,file));assert(bytes.length<5_000_000);
    assets.push({file,bytes:bytes.length,width:1500,height:1000,sha256:createHash('sha256').update(bytes).digest('hex'),capture,captureSha256:createHash('sha256').update(original).digest('hex')});
  }
  assert.equal(errors.length,0);
} finally {await browser.close();}
writeFileSync('docs/nostrchat/submission/MEDIA-MANIFEST.json',JSON.stringify({status:'rendered-awaiting-visual-review',sourceReport:proof.artifactDirectory+'/verification.json',paymentHash:proof.transaction.paymentHash,amountSats:100,network:'regtest',monetaryValue:false,assets,pageErrors:errors},null,2)+'\n');
console.log(JSON.stringify({status:'rendered-awaiting-visual-review',images:assets.length,output}));process.exit(0);
