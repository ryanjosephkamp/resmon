import React from 'react';
import {render,screen,fireEvent,act,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom';
import LibraryPage from '../pages/LibraryPage';
import {CREATE_VAULT_TIMEOUT_MESSAGE,LibraryFile,libraryApi} from '../api/library';
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
it.each(['open_success','open_error','detail_error'])('does not act on late %s after switching items',async(kind)=>{
 let resolve:(x:unknown)=>void=()=>{};let reject:(x:Error)=>void=()=>{};const held=new Promise((r,j)=>{resolve=r;reject=j;});
 if(kind==='detail_error')(libraryApi.detail as jest.Mock).mockReturnValueOnce(held);
 render(<LibraryPage/>);await choose(2);
 if(kind.startsWith('open')){(libraryApi.open as jest.Mock).mockReturnValueOnce(held);fireEvent.click(screen.getByText('Open externally'));}
 await choose(1);await screen.findByRole('heading',{name:'Paper 1.txt'});
 await act(async()=>{if(kind.endsWith('error'))reject(new Error('late old error'));else resolve('/old/file');});
 expect(window.resmonAPI?.openPath).not.toHaveBeenCalled();expect(downloadInventory).not.toHaveBeenCalled();expect(screen.queryByText(/late old error/)).toBeNull();
});
// Open and detail belong to the selected item, so switching items is the user
// saying they are no longer wanted. An inventory export belongs to the vault.
// It used to be discarded on a selection change too, because every control read
// one shared generation counter - so a user who clicked an item while the export
// was out got no download and no refusal, only a button that had done nothing.
it.each(['export_success','export_error'])('still reports a late %s after switching items',async(kind)=>{
 let resolve:(x:unknown)=>void=()=>{};let reject:(x:Error)=>void=()=>{};const held=new Promise((r,j)=>{resolve=r;reject=j;});
 (libraryApi.inventory as jest.Mock).mockReturnValueOnce(held);
 render(<LibraryPage/>);await choose(2);
 fireEvent.click(screen.getByText('Export complete JSON inventory'));
 await choose(1);await screen.findByRole('heading',{name:'Paper 1.txt'});
 await act(async()=>{if(kind==='export_error')reject(new Error('inventory refused'));else resolve({text:'export'});});
 if(kind==='export_error'){expect(await screen.findByRole('alert')).toHaveTextContent('inventory refused');expect(downloadInventory).not.toHaveBeenCalled();}
 else{expect(downloadInventory).toHaveBeenCalledWith({text:'export'},vid);expect(await screen.findByText(/Complete JSON inventory download requested/)).toBeInTheDocument();}
});
it('still reports an inventory export that finished after Refresh Library was pressed',async()=>{
 // Refresh Library is not disabled by ``busy``, so it is pressable throughout an
 // export, and it runs ``load`` - which opened with ``select(null)``.
 let resolve:(x:unknown)=>void=()=>{};(libraryApi.inventory as jest.Mock).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 render(<LibraryPage/>);
 fireEvent.click(await screen.findByText('Export complete JSON inventory'));
 fireEvent.click(screen.getByText('Refresh Library'));
 await waitFor(()=>expect(libraryApi.status).toHaveBeenCalledTimes(2));
 await act(async()=>{resolve({text:'export'});});
 expect(downloadInventory).toHaveBeenCalledWith({text:'export'},vid);
 expect(await screen.findByText(/Complete JSON inventory download requested/)).toBeInTheDocument();
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
it('keeps the parent folder from the most recent picker, not from whichever answered last',async()=>{
 // Not a regression test - this passed before too. It pins the one thing the
 // per-control counters still do, now that a selection or a Refresh no longer
 // makes a run stale: a later run of the same control supersedes an earlier
 // one. ``Choose parent folder`` is gated on ``creating``, not on a picker
 // already being open, so the renderer really can have two out at once; what
 // prevents it in the packaged app is that the desktop dialog is window-modal,
 // which is not a property of this page.
 (libraryApi.status as jest.Mock).mockResolvedValue({...status,vault:null,status:'unconfigured'});
 let first:(p:string)=>void=()=>{};let second:(p:string)=>void=()=>{};
 window.resmonAPI!.chooseDirectory=jest.fn()
   .mockReturnValueOnce(new Promise<string>(r=>{first=r;}))
   .mockReturnValueOnce(new Promise<string>(r=>{second=r;}));
 render(<LibraryPage/>);await screen.findByRole('heading',{name:'Create your managed vault'});
 fireEvent.click(screen.getByText('Choose parent folder'));fireEvent.click(screen.getByText('Choose parent folder'));
 await act(async()=>{second('/owned/newer');});await act(async()=>{first('/owned/older');});
 expect(await screen.findByText('/owned/newer')).toBeInTheDocument();expect(screen.queryByText('/owned/older')).toBeNull();
});
it('says which of working, failed and finished a vault creation is in',async()=>{
 // The reported defect: both creation controls disabled past thirty seconds
 // with no completion notice, error, progress text or vault. A promise that
 // never settles is the only shape that produces it, so that is what is held
 // here - and the page must still say it is working, and must end in a
 // sentence when the attempt is given up.
 (libraryApi.status as jest.Mock).mockResolvedValue({...status,vault:null,status:'unconfigured'});window.resmonAPI!.chooseDirectory=jest.fn(async()=>'/owned/parent');
 let fail:(e:Error)=>void=()=>{};(libraryApi.create as jest.Mock).mockReturnValueOnce(new Promise((_r,j)=>{fail=j;}));
 render(<LibraryPage/>);await screen.findByRole('heading',{name:'Create your managed vault'});
 fireEvent.click(screen.getByText('Choose parent folder'));await screen.findByText('/owned/parent');
 fireEvent.click(screen.getByRole('button',{name:'Create managed vault'}));
 expect(await screen.findByText(/Creating the managed vault/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Create managed vault'})).toBeDisabled();expect(screen.getByRole('button',{name:'Choose parent folder'})).toBeDisabled();
 await act(async()=>{fail(new Error('Library storage is unavailable or blocked. No automatic recovery was attempted.'));});
 expect(await screen.findByRole('alert')).toHaveTextContent('Library storage is unavailable or blocked');
 expect(screen.queryByText(/Creating the managed vault/)).toBeNull();
 expect(screen.getByRole('button',{name:'Choose parent folder'})).toBeEnabled();expect(screen.getByRole('button',{name:'Create managed vault'})).toBeEnabled();
});
it('keeps a given-up vault creation on screen when Refresh Library was pressed while it was out',async()=>{
 // Refresh Library is the one control left enabled during a create, and the
 // sentence the deadline writes names it as the thing to press. Refresh runs
 // ``load``, which opened with ``select(null)`` and so bumped the one counter
 // every control shared - and the create's own outcome was then dropped as
 // stale. The page went back to two enabled buttons with nothing written
 // anywhere: the original silence, reached by following the new message.
 (libraryApi.status as jest.Mock).mockResolvedValue({...status,vault:null,status:'unconfigured'});window.resmonAPI!.chooseDirectory=jest.fn(async()=>'/owned/parent');
 let fail:(e:Error)=>void=()=>{};(libraryApi.create as jest.Mock).mockReturnValueOnce(new Promise((_r,j)=>{fail=j;}));
 render(<LibraryPage/>);await screen.findByRole('heading',{name:'Create your managed vault'});
 fireEvent.click(screen.getByText('Choose parent folder'));await screen.findByText('/owned/parent');
 fireEvent.click(screen.getByRole('button',{name:'Create managed vault'}));
 await screen.findByText(/Creating the managed vault/);
 fireEvent.click(screen.getByText('Refresh Library'));
 await waitFor(()=>expect(libraryApi.status).toHaveBeenCalledTimes(2));
 await act(async()=>{fail(new Error(CREATE_VAULT_TIMEOUT_MESSAGE));});
 const said=await screen.findByText(CREATE_VAULT_TIMEOUT_MESSAGE);
 // An unknown outcome is not a refusal, so it is not in the line this page
 // uses to quote what resmon said when it said no.
 expect(said).toHaveAttribute('role','status');expect(screen.queryByRole('alert')).toBeNull();
 expect(screen.getByRole('button',{name:'Create managed vault'})).toBeEnabled();
});
it('confirms a finished vault creation in words rather than only by the section disappearing',async()=>{
 (libraryApi.status as jest.Mock).mockResolvedValueOnce({...status,vault:null,status:'unconfigured'}).mockResolvedValue(status);
 window.resmonAPI!.chooseDirectory=jest.fn(async()=>'/owned/parent');(libraryApi.create as jest.Mock).mockResolvedValue(status);
 render(<LibraryPage/>);await screen.findByRole('heading',{name:'Create your managed vault'});
 fireEvent.click(screen.getByText('Choose parent folder'));await screen.findByText('/owned/parent');
 fireEvent.click(screen.getByRole('button',{name:'Create managed vault'}));
 expect(await screen.findByText(/Managed vault created/)).toBeInTheDocument();
 expect(await screen.findByLabelText('Import PDF, TXT or MD')).toBeEnabled();
});
it('imports selected files sequentially and preserves a visible failed receipt',async()=>{
 let active=0,max=0;(libraryApi.import as jest.Mock).mockImplementation(async()=>{active++;max=Math.max(active,max);await Promise.resolve();active--;return {file:file(3),created:true};});
 render(<LibraryPage/>);await screen.findByLabelText('Import PDF, TXT or MD');fireEvent.change(screen.getByLabelText('Import PDF, TXT or MD'),{target:{files:[new File(['a'],'a.txt'),new File(['b'],'b.md')]}});
 await screen.findByText(/2 retained, 0 exact duplicates/);expect(max).toBe(1);
 (libraryApi.import as jest.Mock).mockRejectedValueOnce(new Error('storage full'));fireEvent.change(screen.getByLabelText('Import PDF, TXT or MD'),{target:{files:[new File(['c'],'c.txt')]}});
 expect(await screen.findByRole('alert')).toHaveTextContent('storage full');
});
// Refresh, Search and Next 50 are all disabled during an import. The item
// buttons in the list are not, and neither is Close in the detail panel - both
// call ``select``, which bumped the shared counter. An import that finished
// after one of those clicks reported nothing at all: not the receipt, and not
// the failure that stopped the batch.
it.each(['import_success','import_failure'])('still reports %s when an item was selected while it ran',async(kind)=>{
 let resolve:(x:unknown)=>void=()=>{};let reject:(x:Error)=>void=()=>{};
 (libraryApi.import as jest.Mock).mockReturnValueOnce(new Promise((r,j)=>{resolve=r;reject=j;}));
 render(<LibraryPage/>);await screen.findByLabelText('Import PDF, TXT or MD');
 fireEvent.change(screen.getByLabelText('Import PDF, TXT or MD'),{target:{files:[new File(['a'],'a.txt')]}});
 await screen.findByText(/Importing selected files/);
 await choose(2);await screen.findByRole('heading',{name:'Paper 2.txt'});
 await act(async()=>{if(kind==='import_failure')reject(new Error('storage full'));else resolve({file:file(3),created:true});});
 if(kind==='import_failure')expect(await screen.findByRole('alert')).toHaveTextContent('storage full');
 else expect(await screen.findByText(/1 retained, 0 exact duplicates/)).toBeInTheDocument();
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

it('offers the exact PDF Evidence handoff instead of the text-only reader',async()=>{
 const pdf={...file(3),original_name:'Review.pdf',media_type:'application/pdf'};
 (libraryApi.list as jest.Mock).mockResolvedValue({...page(),files:[pdf]});
 (libraryApi.detail as jest.Mock).mockResolvedValue(pdf);render(<LibraryPage/>);
 fireEvent.click(await screen.findByRole('button',{name:/Review.pdf application\/pdf/}));
 const link=await screen.findByRole('link',{name:'Read PDF in Evidence'});
 expect(Object.fromEntries(new URLSearchParams(link.getAttribute('href')!.split('?')[1]))).toEqual({vault_id:pdf.vault_id,file_id:pdf.file_id,version_id:pdf.version_id});
 expect(screen.queryByRole('button',{name:'Read text'})).toBeNull();
 expect(libraryApi.text).not.toHaveBeenCalled();expect(libraryApi.import).not.toHaveBeenCalled();
});
