import React from 'react';
import {render,screen,fireEvent,act} from '@testing-library/react';
import '@testing-library/jest-dom';
import LibraryPage from '../pages/LibraryPage';
import {LibraryFile,libraryApi} from '../api/library';
jest.mock('../api/library',()=>({...jest.requireActual('../api/library'),libraryApi:{status:jest.fn(),create:jest.fn(),list:jest.fn(),detail:jest.fn(),import:jest.fn(),link:jest.fn(),open:jest.fn(),text:jest.fn(),inventory:jest.fn()}}));
jest.mock('../lib/libraryDownload',()=>({downloadInventory:jest.fn()}));
const vid='11111111-1111-4111-8111-111111111111';
const file=(id:number):LibraryFile=>({id,file_id:`22222222-2222-4222-8222-${String(id).padStart(12,'0')}`,version_id:`33333333-3333-4333-8333-${String(id).padStart(12,'0')}`,vault_id:vid,sha256:'a'.repeat(64),byte_size:4,media_type:'text/plain',original_name:`Paper ${id}.txt`,relative_path:'synthetic',created_at_utc:'now',paper_links:[],availability:'not_checked'});
const status={version:1,vault:{vault_id:vid,label:`resmon-library-${vid}`,created_at_utc:'now'},status:'ready',counts:{items:123,retained_bytes:492,basis:'recorded_metadata'},limits:{file_bytes:67108864,batch_files:20,vault_bytes:1073741824,items:10000}};
const page=(ids=[2,1])=>({version:1,vault_id:vid,files:ids.map(file),through_id:123,next_before_id:null,has_more:false});
beforeEach(()=>{jest.clearAllMocks();(libraryApi.status as jest.Mock).mockResolvedValue(status);(libraryApi.list as jest.Mock).mockResolvedValue(page());(libraryApi.detail as jest.Mock).mockImplementation(async(_v:string,fid:string)=>file(Number(fid.slice(-12))));window.resmonAPI={getBackendPort:()=>'12345',platform:'test',versions:{node:'test',electron:'test'},openPath:jest.fn(async()=>'')};});
const choose=async(id:number)=>fireEvent.click(await screen.findByRole('button',{name:new RegExp(`Paper ${id}\\.txt text/plain`)}));
// A promise the test settles by hand, so the window between "the refresh went
// out" and "the refresh came back" can hold a user action.
const held=<T,>()=>{let resolve:(x:T)=>void=()=>{};let reject:(e:Error)=>void=()=>{};const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};

// The detail panel refreshes its metadata on mount, and ``Open externally`` is
// enabled from the first render, so the user can act before that refresh lands.
// The panel kept one generation counter for the refresh and both actions, and
// every one of them bumped it, so starting an action discarded the refresh.
// Nothing told the user: a refusal the refresh came back with was dropped on
// the floor, and so was the freshened metadata the panel is built on.

it('reports a refused metadata refresh that landed after Open externally was clicked',async()=>{
 const refresh=held<LibraryFile>();(libraryApi.detail as jest.Mock).mockReturnValueOnce(refresh.promise);
 (libraryApi.open as jest.Mock).mockResolvedValue('/owned/retained.txt');
 render(<LibraryPage/>);await choose(2);
 fireEvent.click(await screen.findByText('Open externally'));
 await screen.findByText(/Open requested/);
 await act(async()=>{refresh.reject(new Error('Library storage is unavailable or blocked. No automatic recovery was attempted.'));});
 expect(await screen.findByRole('alert')).toHaveTextContent('Library storage is unavailable or blocked');
});

it('reports a refused metadata refresh that landed after Associate paper was submitted',async()=>{
 const refresh=held<LibraryFile>();(libraryApi.detail as jest.Mock).mockReturnValueOnce(refresh.promise);
 (libraryApi.link as jest.Mock).mockResolvedValue({});
 render(<LibraryPage/>);await choose(2);
 fireEvent.change(await screen.findByLabelText('Existing paper ID'),{target:{value:'7'}});
 fireEvent.click(screen.getByText('Associate paper'));
 await screen.findByText(/Linked local paper 7/);
 await act(async()=>{refresh.reject(new Error('This file is not in the selected vault.'));});
 expect(await screen.findByRole('alert')).toHaveTextContent('This file is not in the selected vault.');
});

it('applies refreshed associations from a refresh that landed after Open externally was clicked',async()=>{
 const refresh=held<LibraryFile>();(libraryApi.detail as jest.Mock).mockReturnValueOnce(refresh.promise);
 (libraryApi.open as jest.Mock).mockResolvedValue('/owned/retained.txt');
 render(<LibraryPage/>);await choose(2);
 expect(await screen.findByText('No local papers associated.')).toBeInTheDocument();
 fireEvent.click(screen.getByText('Open externally'));
 await screen.findByText(/Open requested/);
 await act(async()=>{refresh.resolve({...file(2),paper_links:[{document_id:7,title:'A retained paper',identity_scope:'this app database only',basis:'owner_association'}]});});
 expect(await screen.findByText(/Paper 7: A retained paper/)).toBeInTheDocument();
});

it('still runs the changed-version check on a refresh that landed after Open externally was clicked',async()=>{
 // What this case does and does not say. ``library_files.file_id`` is UNIQUE
 // and the only statement touching that table in the backend is one INSERT at
 // import, so resmon's own writes never give a file a second version - the
 // register row for owned Library says as much, that a version is immutable.
 // This is the renderer's own guard against a catalog that disagrees with the
 // page it was listed from, and the case pins that the guard still runs, not
 // that a user can reach the condition through the app.
 const refresh=held<LibraryFile>();(libraryApi.detail as jest.Mock).mockReturnValueOnce(refresh.promise);
 (libraryApi.open as jest.Mock).mockResolvedValue('/owned/retained.txt');
 render(<LibraryPage/>);await choose(2);
 fireEvent.click(await screen.findByText('Open externally'));
 await screen.findByText(/Open requested/);
 await act(async()=>{refresh.resolve({...file(2),version_id:'33333333-3333-4333-8333-000000000099'});});
 expect(await screen.findByRole('alert')).toHaveTextContent('Selected version changed. Reselect this item.');
});

// The two cases below are pins, not regression tests: both pass before this
// change and after it. They hold the line the per-control counters must not
// cross - the panel going away still cancels everything that was out, which is
// the condition the counters deliberately stopped carrying.

it('still drops a metadata refresh for an item the user has moved off',async()=>{
 const refresh=held<LibraryFile>();(libraryApi.detail as jest.Mock).mockReturnValueOnce(refresh.promise);
 render(<LibraryPage/>);await choose(2);
 await choose(1);await screen.findByRole('heading',{name:'Paper 1.txt'});
 await act(async()=>{refresh.reject(new Error('refresh for the item left behind'));});
 expect(screen.queryByText(/refresh for the item left behind/)).toBeNull();
});

it('still abandons an Open the user closed the panel on',async()=>{
 // Worth saying out loud: this is the behavior on both sides of this change,
 // and it is not obviously the right one. ``Close item`` is never disabled, so
 // a user can ask for an external Open and close the panel before the path
 // comes back, and the file then never opens with nowhere left to say so.
 // Changing that is a different decision from this one and is not taken here.
 const open=held<string>();(libraryApi.open as jest.Mock).mockReturnValueOnce(open.promise);
 render(<LibraryPage/>);await choose(2);
 fireEvent.click(await screen.findByText('Open externally'));
 fireEvent.click(screen.getByText('Close item'));
 await act(async()=>{open.resolve('/owned/retained.txt');});
 expect(window.resmonAPI?.openPath).not.toHaveBeenCalled();
});
