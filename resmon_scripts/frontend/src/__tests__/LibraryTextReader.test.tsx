import React from 'react';
import {render,screen,fireEvent,act} from '@testing-library/react';
import '@testing-library/jest-dom';
import {TextEncoder} from 'util';
import LibraryTextReader from '../components/Library/LibraryTextReader';
import {LibraryFile,libraryApi,validateText} from '../api/library';
jest.mock('../api/library',()=>({...jest.requireActual('../api/library'),libraryApi:{text:jest.fn()}}));
const file:LibraryFile={id:1,file_id:'11111111-1111-4111-8111-111111111111',version_id:'11111111-1111-4111-8111-111111111112',vault_id:'11111111-1111-4111-8111-111111111113',sha256:'a'.repeat(64),media_type:'text/plain',byte_size:20,original_name:'literal.txt',relative_path:'files/11111111-1111-4111-8111-111111111111/11111111-1111-4111-8111-111111111112.txt',created_at_utc:'now',paper_links:[],availability:'not_checked'};
const response=(f=file,text='one target\ntwo target\n')=>({version:1,kind:'resmon-library-text',vault_id:f.vault_id,file_id:f.file_id,version_id:f.version_id,sha256:f.sha256,media_type:f.media_type,encoding:'utf-8',normalization:'crlf-cr-to-lf-v1',byte_size:f.byte_size,line_count:text.split('\n').length,text});
beforeEach(()=>{jest.clearAllMocks();Object.assign(global,{TextEncoder});HTMLElement.prototype.scrollIntoView=jest.fn();(libraryApi.text as jest.Mock).mockResolvedValue(response());});
it('renders literal lines and finds/navigates with accessible focus',async()=>{
 render(<LibraryTextReader file={file} onClose={()=>{}}/>);await screen.findByText('one target');
 const find=screen.getByLabelText('Find in this text');fireEvent.change(find,{target:{value:'target'}});
 expect(screen.getByText('1 of 2 matches')).toBeInTheDocument();fireEvent.click(screen.getByText('Next match'));
 expect(screen.getByText('2 of 2 matches')).toBeInTheDocument();expect(document.activeElement).toHaveAttribute('data-library-line','1');
 fireEvent.click(screen.getByText('Previous match'));expect(document.activeElement).toHaveAttribute('data-library-line','0');
 fireEvent.change(find,{target:{value:'[not a regex]'}});expect(screen.getByText('No matches.')).toBeInTheDocument();
 fireEvent.change(find,{target:{value:''}});expect(screen.getByText('Next match')).toBeDisabled();
});
it('script, image, link and command strings remain text nodes',async()=>{
 const hostile='<script>window.changed=true</script> <img src="https://host.invalid/x"> [link](https://host.invalid) $(rm -rf fiction)';
 (libraryApi.text as jest.Mock).mockResolvedValue(response(file,hostile));render(<LibraryTextReader file={file} onClose={()=>{}}/>);
 await screen.findByText(hostile);expect(document.querySelector('script,img,a')).toBeNull();
});
it.each(['success','error'])('ignores a late %s after selection changes',async(mode)=>{
 let resolve:(x:unknown)=>void=()=>{};let reject:(x:Error)=>void=()=>{};
 (libraryApi.text as jest.Mock).mockReturnValueOnce(new Promise((r,j)=>{resolve=r;reject=j;}));
 const {rerender}=render(<LibraryTextReader file={file} onClose={()=>{}}/>);
 const next={...file,file_id:'22222222-2222-4222-8222-222222222222',version_id:'22222222-2222-4222-8222-222222222223'};
 (libraryApi.text as jest.Mock).mockResolvedValue(response(next,'current text'));rerender(<LibraryTextReader file={next} onClose={()=>{}}/>);await screen.findByText('current text');
 await act(async()=>{if(mode==='success')resolve(response(file,'stale text'));else reject(new Error('stale failure'));});
 expect(screen.getByText('current text')).toBeInTheDocument();expect(screen.queryByText(/stale/)).toBeNull();
});
it('close invalidates a pending read, and a refusal states that bytes remain retained',async()=>{
 const close=jest.fn();let resolve:(x:unknown)=>void=()=>{};(libraryApi.text as jest.Mock).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 const {unmount}=render(<LibraryTextReader file={file} onClose={close}/>);fireEvent.click(screen.getByText('Close reader'));expect(close).toHaveBeenCalledTimes(1);
 await act(async()=>resolve(response(file,'late content')));expect(screen.queryByText('late content')).toBeNull();unmount();
 (libraryApi.text as jest.Mock).mockRejectedValue(new Error('PDF unsupported'));render(<LibraryTextReader file={{...file,media_type:'application/pdf'}} onClose={()=>{}}/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('retained item remains');
});
it.each(['vault_id','file_id','version_id','sha256','byte_size','line_count','normalization','extra'])('rejects wrong or extra envelope %s',key=>{
 const value={...response(),[key]:key==='extra'?'private':null};expect(()=>validateText(value,file)).toThrow();
});
