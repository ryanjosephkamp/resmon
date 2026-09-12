import type { PdfModule } from '../types/pdfjs';
export const PDF_VERSION='6.3.289';
export const MAX_PIXELS=4_000_000;
export const MAX_CANVAS_BYTES=16*1024*1024;
export const RENDER_TIMEOUT=20_000;
export function pdfAsset(relative:string):string {
  const root=new URL('./pdfjs/6.3.289/',document.baseURI);
  const target=new URL(relative,root);
  if(target.origin!==window.location.origin||!target.href.startsWith(root.href))throw new Error('PDF assets must remain in the fixed local distribution.');
  return target.href;
}
let pending:Promise<PdfModule>|undefined;
export function loadPdfJs():Promise<PdfModule>{
  if(!pending)pending=import(/* webpackIgnore: true */ pdfAsset('build/pdf.min.js')).then((value:unknown)=>{
    const api=value as PdfModule;
    if(api.version!==PDF_VERSION||typeof api.PDFWorker!=='function'||typeof api.getDocument!=='function'||api.AnnotationMode?.DISABLE!==0)throw new Error('The local PDF display and worker version must match.');
    return api;
  });
  return pending;
}
export function canvasScale(width:number,height:number,requested:number):{scale:number;width:number;height:number;reduced:boolean}{
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Number.isFinite(requested)||requested<=0)throw new Error('Unsupported PDF page dimensions.');
  const scale=Math.min(requested,Math.sqrt(MAX_PIXELS/(width*height)),Math.sqrt(MAX_CANVAS_BYTES/(width*height*4)));
  const w=Math.floor(width*scale),h=Math.floor(height*scale);
  if(w<1||h<1||w*h>MAX_PIXELS||w*h*4>MAX_CANVAS_BYTES)throw new Error('Unsupported bounded canvas dimensions.');
  return {scale,width:w,height:h,reduced:scale<requested};
}
