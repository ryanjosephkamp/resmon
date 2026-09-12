import React,{useEffect,useRef,useState} from 'react';
import { evidenceApi,EvidenceFile,Project } from '../../api/evidence';
import { canvasScale,loadPdfJs,pdfAsset,PDF_VERSION,RENDER_TIMEOUT } from '../../lib/pdfjs';
import type { PdfLoadingTask,PdfPageProxy,PdfRenderTask,PdfWorker } from '../../types/pdfjs';

export default function PdfPage({project,file,page}:{project:Project;file:EvidenceFile;page:number}){
  const canvas=useRef<HTMLCanvasElement>(null);const [zoom,setZoom]=useState(1);const [status,setStatus]=useState('');const [error,setError]=useState('');
  useEffect(()=>{
    let live=true;const abort=new AbortController();let native:Worker|undefined;let worker:PdfWorker|undefined;let loading:PdfLoadingTask|undefined;let rendering:PdfRenderTask|undefined;let pdfPage:PdfPageProxy|undefined;
    const clear=()=>{rendering?.cancel();void loading?.destroy().catch(()=>{});worker?.destroy();native?.terminate();pdfPage?.cleanup();if(canvas.current){canvas.current.width=0;canvas.current.height=0;}};
    setError('');setStatus('Loading bounded PDF page…');
    const timeout=window.setTimeout(()=>{if(live){live=false;abort.abort();clear();setStatus('');setError('PDF rendering timed out after 20 seconds. The worker was terminated.');}},RENDER_TIMEOUT);
    void(async()=>{
      try{
        const data=await evidenceApi.pdf(project,file,abort.signal);if(!live)return;
        const api=await loadPdfJs();if(!live)return;
        native=new Worker(pdfAsset('build/pdf.worker.min.js'),{type:'module',name:`resmon-pdf-${PDF_VERSION}`});
        native.onerror=()=>{if(live){live=false;abort.abort();clear();window.clearTimeout(timeout);setStatus('');setError('The local PDF worker failed. No main-thread fallback is used.');}};
        worker=new api.PDFWorker({port:native,name:`resmon-pdf-${PDF_VERSION}`});await worker.promise;if(!live)return;
        loading=api.getDocument({data,worker,enableXfa:false,useWasm:false,useSystemFonts:false,useWorkerFetch:false,stopAtErrors:true,disableAutoFetch:true,disableStream:true,disableRange:true,cMapUrl:pdfAsset('cmaps/'),cMapPacked:true,standardFontDataUrl:pdfAsset('standard_fonts/'),maxImageSize:4_000_000,canvasMaxAreaInBytes:16*1024*1024});
        const doc=await loading.promise;if(!live)return;
        if(doc.numPages>200||page>doc.numPages)throw new Error('PDF exceeds the 200-page bound or selected page is unavailable.');
        pdfPage=await doc.getPage(page);if(!live)return;
        const original=pdfPage.getViewport({scale:1});const size=canvasScale(original.width,original.height,zoom);
        const node=canvas.current;if(!node)throw new Error('Canvas unavailable.');const context=node.getContext('2d');if(!context)throw new Error('Canvas unavailable.');
        node.width=size.width;node.height=size.height;
        rendering=pdfPage.render({canvas:node,canvasContext:context,viewport:pdfPage.getViewport({scale:size.scale}),annotationMode:api.AnnotationMode.DISABLE});await rendering.promise;
        if(live){window.clearTimeout(timeout);setStatus(`Page ${page} of ${doc.numPages} rendered · PDF.js ${PDF_VERSION} · ${size.width} × ${size.height} pixels${size.reduced?' · reduced resolution to stay within the canvas budget':''}.`);}
      }catch(reason){if(live){window.clearTimeout(timeout);clear();setStatus('');setError(`Visual page unavailable: ${reason instanceof Error?reason.message:'unsupported PDF'}`);}}
    })();
    return()=>{live=false;window.clearTimeout(timeout);abort.abort();clear();};
  },[project.vault_id,project.project_id,file.file_id,file.version_id,file.sha256,page,zoom]);
  return <section className="evidence-pdf" aria-label="PDF page image">
    <label>PDF zoom<select value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[0.5,1,1.5,2,3].map(z=><option key={z} value={z}>{z*100}%</option>)}</select></label>
    {status&&<p role="status">{status}</p>}{error&&<p role="alert">{error}</p>}
    <canvas ref={canvas} aria-label={`Visual PDF page ${page}`} data-pdf-version={PDF_VERSION}/>
    <p>Page image only. PDF links, actions, forms and attachments are inactive. Use the canonical text pane to select a passage; visual fidelity and text coverage may differ.</p>
  </section>;
}
