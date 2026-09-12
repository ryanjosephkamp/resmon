/** Only the selected public PDF.js 6.3.289 canvas/worker APIs. */
export interface PdfViewport {width:number; height:number}
export interface PdfRenderTask {promise:Promise<void>; cancel():void}
export interface PdfPageProxy {getViewport(options:{scale:number}):PdfViewport; render(options:{canvas:HTMLCanvasElement;canvasContext:CanvasRenderingContext2D;viewport:PdfViewport;annotationMode:number}):PdfRenderTask; cleanup():boolean}
export interface PdfDocument {numPages:number;getPage(page:number):Promise<PdfPageProxy>;destroy():Promise<void>}
export interface PdfWorker {promise:Promise<void>;destroy():void}
export interface PdfLoadingTask {promise:Promise<PdfDocument>;destroy():Promise<void>}
export interface PdfModule {
  version:string; PDFWorker:new(options:{port:Worker;name:string})=>PdfWorker;
  AnnotationMode:{DISABLE:number};
  getDocument(options:{data:Uint8Array;worker:PdfWorker;enableXfa:false;useWasm:false;useSystemFonts:false;useWorkerFetch:false;stopAtErrors:true;disableAutoFetch:true;disableStream:true;disableRange:true;cMapUrl:string;cMapPacked:true;standardFontDataUrl:string;maxImageSize:number;canvasMaxAreaInBytes:number}):PdfLoadingTask;
}
