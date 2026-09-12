import React from 'react';
import {render,screen,fireEvent,act,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom';
import LibraryPage from '../pages/LibraryPage';
import {LibraryFile,libraryApi} from '../api/library';
import {downloadInventory} from '../lib/libraryDownload';
jest.mock('../api/library',()=>({...jest.requireActual('../api/library'),libraryApi:{status:jest.fn(),create:jest.fn(),list:jest.fn(),detail:jest.fn(),import:jest.fn(),link:jest.fn(),open:jest.fn(),text:jest.fn(),inventory:jest.fn()}}));
jest.mock('../lib/libraryDownload',()=>({downloadInventory:jest.fn()}));
const vid='11111111-1111-4111-8111-111111111111';
const file=(id:number):LibraryFile=>({id,file_id:`22222222-2222-4222-8222-${String(id).padStart(12,'0')}`,version_id:`33333333-3333-4333-8333-${String(id).padStart(12,'0')}`,vault_id:vid,sha256:'a'.repeat(64),byte_size:4,media_type:'text/plain',original_name:`Paper ${id}.txt`,relative_path:'synthetic',created_at_utc:'now',paper_links:[],availability:'not_checked'});
const status={version:1,vault:{vault_id:vid,label:`resmon-library-${vid}`,created_at_utc:'now'},status:'ready',counts:{items:123,retained_bytes:492,basis:'recorded_metadata'},limits:{file_bytes:67108864,batch_files:20,vault_bytes:1073741824,items:10000}};
const page=(ids=[2,1],more=false)=>({version:1,vault_id:vid,files:ids.map(file),through_id:123,next_before_id:more?ids[ids.length-1]:null,has_more:more});
beforeEach(()=>{jest.clearAllMocks();(libraryApi.status as jest.Mock).mockResolvedValue(status);(libraryApi.list as jest.Mock).mockResolvedValue(page());(libraryApi.detail as jest.Mock).mockImplementation(async(_v:string,fid:string)=>file(Number(fid.slice(-12))));window.resmonAPI={getBackendPort:()=> '12345',platform:'test',versions:{node:'test',electron:'test'},openPath:jest.fn(async()=> '')};});
const choose=async(id:number)=>fireEvent.click(await screen.findByRole('button',{name:new RegExp(`Paper ${id}\\.txt text/plain`)}));
it('shows exact selected item and requests the verified Open bridge',async()=>{
 (libraryApi.open as jest.Mock).mockResolvedValue('/owned/retained.txt');render(<LibraryPage/>);await choose(2);await screen.findByRole('heading',{name:'Paper 2.txt'});
 fireEvent.click(screen.getByText('Open externally'));await screen.findByText(/Open requested/);expect(window.resmonAPI?.openPath).toHaveBeenCalledWith('/owned/retained.txt');
});
it.each(['open_success','open_error','detail_error','export_success','export_error'])('does not act on late %s after switching items',async(kind)=>{
 let resolve:(x:unknown)=>void=()=>{};let reject:(x:Error)=>void=()=>{};const held=new Promise((r,j)=>{resolve=r;reject=j;});
 if(kind==='detail_error')(libraryApi.detail as jest.Mock).mockReturnValueOnce(held);
 render(<LibraryPage/>);await choose(2);
 if(kind.startsWith('open')){(libraryApi.open as jest.Mock).mockReturnValueOnce(held);fireEvent.click(screen.getByText('Open externally'));}
 if(kind.startsWith('export')){(libraryApi.inventory as jest.Mock).mockReturnValueOnce(held);fireEvent.click(screen.getByText('Export complete JSON inventory'));}
 await choose(1);await screen.findByRole('heading',{name:'Paper 1.txt'});
 await act(async()=>{if(kind.endsWith('error'))reject(new Error('late old error'));else resolve(kind.startsWith('open')?'/old/file':{text:'old export'});});
 expect(window.resmonAPI?.openPath).not.toHaveBeenCalled();expect(downloadInventory).not.toHaveBeenCalled();expect(screen.queryByText(/late old error/)).toBeNull();
});
it('holds the paging ceiling, supports literal search and rejects 21-file batches',async()=>{
 (libraryApi.list as jest.Mock).mockResolvedValueOnce(page([123,74],true)).mockResolvedValue(page([73,24]));render(<LibraryPage/>);
 fireEvent.click(await screen.findByText('Next 50 items'));await waitFor(()=>expect(libraryApi.list).toHaveBeenLastCalledWith(vid,'',123,74));
 fireEvent.change(screen.getByLabelText('Search filenames'),{target:{value:'%_'}});fireEvent.click(screen.getByText('Search Library'));
 await waitFor(()=>expect(libraryApi.list).toHaveBeenLastCalledWith(vid,'%_',undefined,undefined));
 fireEvent.change(screen.getByLabelText('Import PDF, TXT or MD'),{target:{files:Array.from({length:21},(_,i)=>new File(['x'],`${i}.txt`))}});
 expect(await screen.findByRole('alert')).toHaveTextContent('at most 20');expect(libraryApi.import).not.toHaveBeenCalled();
});
it('creates only after picker selection and an explicit Create action',async()=>{
 (libraryApi.status as jest.Mock).mockResolvedValue({...status,vault:null,status:'unconfigured'});window.resmonAPI!.chooseDirectory=jest.fn(async()=>'/owned/parent');(libraryApi.create as jest.Mock).mockResolvedValue(status);
 render(<LibraryPage/>);await screen.findByRole('heading',{name:'Create your managed vault'});expect(libraryApi.create).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('Choose parent folder'));await screen.findByText('/owned/parent');expect(libraryApi.create).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Create managed vault'}));await waitFor(()=>expect(libraryApi.create).toHaveBeenCalledWith('/owned/parent'));
});
it('imports selected files sequentially and preserves a visible failed receipt',async()=>{
 let active=0,max=0;(libraryApi.import as jest.Mock).mockImplementation(async()=>{active++;max=Math.max(active,max);await Promise.resolve();active--;return {file:file(3),created:true};});
 render(<LibraryPage/>);await screen.findByLabelText('Import PDF, TXT or MD');fireEvent.change(screen.getByLabelText('Import PDF, TXT or MD'),{target:{files:[new File(['a'],'a.txt'),new File(['b'],'b.md')]}});
 await screen.findByText(/2 retained, 0 exact duplicates/);expect(max).toBe(1);
 (libraryApi.import as jest.Mock).mockRejectedValueOnce(new Error('storage full'));fireEvent.change(screen.getByLabelText('Import PDF, TXT or MD'),{target:{files:[new File(['c'],'c.txt')]}});
 expect(await screen.findByRole('alert')).toHaveTextContent('storage full');
});

it('returns keyboard focus after the disabled read button is reenabled',async()=>{
 (libraryApi.text as jest.Mock).mockReturnValue(new Promise(()=>{}));render(<LibraryPage/>);await choose(2);
 fireEvent.click(screen.getByText('Read text'));expect(screen.getByText('Read text')).toBeDisabled();
 fireEvent.click(screen.getByText('Close reader'));expect(screen.getByText('Read text')).toBeEnabled();expect(screen.getByText('Read text')).toHaveFocus();
});

it.each([undefined,'44444444-4444-4444-8444-444444444444'])('hands off only the selected immutable Library identity with project %s',async(projectId)=>{
 window.location.hash=projectId?'#/library?evidence_project='+projectId:'#/library';render(<LibraryPage/>);await choose(2);
 const link=await screen.findByRole('link',{name:'Open in Evidence / add to project'});const q=new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
 expect(Object.fromEntries(q)).toEqual({vault_id:vid,file_id:file(2).file_id,version_id:file(2).version_id,...(projectId?{project_id:projectId}:{})});expect(libraryApi.import).not.toHaveBeenCalled();expect(libraryApi.link).not.toHaveBeenCalled();window.location.hash='';
});
