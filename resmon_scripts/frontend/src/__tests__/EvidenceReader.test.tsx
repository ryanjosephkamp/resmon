import React from 'react';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import EvidenceReader,{resolveSaved,selectionAnchor} from '../components/Evidence/EvidenceReader';
import {evidenceApi,EvidenceFile,Project,SavedNote,TextPage,validateText} from '../api/evidence';
import {webcrypto,createHash} from 'crypto';
import {TextEncoder} from 'util';
jest.mock('../components/Evidence/PdfPage',()=>()=>null);
const id=(n:number)=>`${n.toString().padStart(8,'0')}-1111-4111-8111-111111111111`;
const file:EvidenceFile={file_id:id(1),version_id:id(2),vault_id:id(3),sha256:'a'.repeat(64),byte_size:200,media_type:'text/plain',original_name:'literal.txt',created_at_utc:'2026-09-12T00:00:00+00:00'};
const project={project_id:id(4),vault_id:file.vault_id,revision:1} as Project;
const text='😀 é first needle\nsecond needle <script>never()</script>';
const basis:TextPage={contract_version:1,vault_id:file.vault_id,project_id:project.project_id,file_id:file.file_id,version_id:file.version_id,sha256:file.sha256,media_type:file.media_type,status:'extracted',page_number:1,page_count:1,text,extraction_contract:'library-text-lf/v1',page_text_sha256:createHash('sha256').update(text).digest('hex'),examined_pages:[1],remaining_pages:'not_examined',coverage:'No OCR'};
beforeAll(()=>{Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});Object.defineProperty(globalThis,'TextEncoder',{value:TextEncoder,configurable:true});});
afterEach(()=>jest.restoreAllMocks());
it('selects the second repeated quote by Unicode codepoints without normalizing combining text',()=>{
 const start=text.lastIndexOf('needle');const anchor=selectionAnchor(basis,start,start+6)!;
 expect(anchor.start_codepoint).toBe(Array.from(text.slice(0,start)).length);expect(anchor.start_codepoint).not.toBe(start);expect(anchor.quote).toBe('needle');
 expect(selectionAnchor(basis,1,3)).toBeNull(); // Middle of the initial surrogate pair.
 const note={...anchor,kind:'passage',file_id:file.file_id,version_id:file.version_id,file} as SavedNote;
 expect(resolveSaved(note,basis)).toBe(true);expect(resolveSaved({...note,extraction_contract:'old'},basis)).toBe(false);expect(resolveSaved({...note,start_codepoint:note.start_codepoint!-1},basis)).toBe(false);
});
it('verifies the returned canonical hash and selected version, rejecting valid-looking forged values',async()=>{
 await expect(validateText(basis,project,file,1)).resolves.toEqual(basis);
 await expect(validateText({...basis,text:'forged'},project,file,1)).rejects.toThrow();
 await expect(validateText({...basis,version_id:id(8)},project,file,1)).rejects.toThrow();
 await expect(validateText({...basis,text:'',status:'no_text',page_text_sha256:basis.page_text_sha256},project,file,1)).rejects.toThrow();
});
it('renders hostile text literally and hands the selected exact occurrence to the editor',async()=>{
 jest.spyOn(evidenceApi,'text').mockResolvedValue(basis);const pick=jest.fn();const view=render(<EvidenceReader project={project} file={file} reopen={null} canSave onPassage={pick}/>);
 const pane=await screen.findByLabelText('Canonical page text');expect(view.container.querySelector('script,img')).toBeNull();
 fireEvent.change(screen.getByLabelText('Find on current canonical page'),{target:{value:'needle'}});fireEvent.click(screen.getByRole('button',{name:'Find next literal match'}));fireEvent.click(screen.getByRole('button',{name:'Find next literal match'}));fireEvent.click(screen.getByRole('button',{name:'Use selected passage'}));
 expect(pick).toHaveBeenCalledWith(selectionAnchor(basis,text.lastIndexOf('needle'),text.lastIndexOf('needle')+6));expect(pane).toHaveFocus();
});
it.each(['success','error'])('suppresses held old %s when the file identity changes',async(outcome)=>{
 let release!:(x:TextPage)=>void;let reject!:(e:Error)=>void;
 const old=new Promise<TextPage>((resolve,refuse)=>{release=resolve;reject=refuse;});
 const nextFile={...file,file_id:id(5),version_id:id(6),original_name:'B.txt'};const next={...basis,file_id:nextFile.file_id,version_id:nextFile.version_id,text:'Selected B',page_text_sha256:'b'.repeat(64)};
 const request=jest.spyOn(evidenceApi,'text').mockReturnValueOnce(old).mockResolvedValueOnce(next);
 const view=render(<EvidenceReader project={project} file={file} reopen={null} canSave onPassage={()=>{}}/>);
 view.rerender(<EvidenceReader project={project} file={nextFile} reopen={null} canSave onPassage={()=>{}}/>);await screen.findByDisplayValue('Selected B');
 await act(async()=>{if(outcome==='success')release(basis);else reject(new Error('old failure'));});
 expect(screen.getByDisplayValue('Selected B')).toBeInTheDocument();expect(screen.queryByText('old failure')).toBeNull();expect(request.mock.calls[0][3]?.aborted).toBe(true);
});
it('keeps saved quote unresolved when current extraction has changed instead of moving its anchor',async()=>{
 const anchor=selectionAnchor(basis,3,5)!;const note={...anchor,kind:'passage',note_id:id(7),file_id:file.file_id,version_id:file.version_id,file,page_text_sha256:'f'.repeat(64)} as SavedNote;
 jest.spyOn(evidenceApi,'text').mockResolvedValue(basis);render(<EvidenceReader project={project} file={file} reopen={note} canSave onPassage={()=>{}}/>);
 await waitFor(()=>expect(screen.getByText(/Saved passage unresolved: this page/)).toBeInTheDocument());
});

it.each(['success','error'])('keeps explicit cancellation after a held %s',async(outcome)=>{
 let release!:(value:TextPage)=>void,refuse!:(reason:Error)=>void;const held=new Promise<TextPage>((resolve,reject)=>{release=resolve;refuse=reject;});
 const request=jest.spyOn(evidenceApi,'text').mockReturnValue(held);render(<EvidenceReader project={project} file={file} reopen={null} canSave onPassage={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Cancel page read'}));expect(request.mock.calls[0][3]?.aborted).toBe(true);
 await act(async()=>{if(outcome==='success')release(basis);else refuse(new Error('Late failure'));});
 expect(screen.getByRole('alert')).toHaveTextContent('Canonical page request cancelled.');expect(screen.queryByLabelText('Canonical page text')).toBeNull();expect(screen.getByRole('button',{name:'Recheck page'})).toBeEnabled();
});
