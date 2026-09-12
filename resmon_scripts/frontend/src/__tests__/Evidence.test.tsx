import React from 'react';import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import ProjectList from '../components/Evidence/ProjectList';
import EvidencePage from '../pages/EvidencePage';import {evidenceApi,EvidenceFile,Member,Project,SavedNote} from '../api/evidence';import {libraryApi} from '../api/library';
jest.mock('../components/Evidence/EvidenceReader',()=>({file,canSave}:{file:EvidenceFile;canSave:boolean})=> <div>Reader fixture {file.original_name} {canSave?'save-enabled':'save-disabled'}</div>);
const id=(n:number)=>`${n.toString().padStart(8,'0')}-1111-4111-8111-111111111111`;
const project=(n:number):Project=>({id:n,project_id:id(n),vault_id:id(9),name:`Project ${n}`,revision:1,created_at_utc:'2026-09-12T00:00:00Z',updated_at_utc:'2026-09-12T00:00:00Z',file_count:0,note_count:0});
const fileFixture=(n:number):EvidenceFile=>({file_id:id(n),version_id:id(n),vault_id:id(9),original_name:`File ${n}.txt`,media_type:'text/plain',byte_size:1,sha256:'a'.repeat(64),created_at_utc:'2026-09-12T00:00:00.000000Z'});
const memberFixture=(file:EvidenceFile,n:number):Member=>({id:n,project_id:id(1),file_id:file.file_id,version_id:file.version_id,added_at_utc:'2026-09-12T00:00:00.000000Z',availability:'not_checked',file});
const noteFixture=(file:EvidenceFile):SavedNote=>({id:1,note_id:id(5),project_id:id(1),file_id:file.file_id,version_id:file.version_id,kind:'note',body:'Saved body',quote:null,page_number:null,revision:1,file,membership_state:'member',resolution:'not_checked',created_at_utc:'2026-09-12T00:00:00.000000Z',updated_at_utc:'2026-09-12T00:00:00.000000Z',extraction_contract:null,page_text_sha256:null,start_codepoint:null,end_codepoint:null});
const page=(items:Project[])=>({items,through_id:2,next_after_id:null,has_more:false,total:items.length,count_basis:'fixture'});
beforeEach(()=>{window.resmonAPI={getBackendPort:()=> '12345',platform:'test',versions:{node:'test',electron:'test'}};window.location.hash='';jest.spyOn(libraryApi,'status').mockResolvedValue({vault:{vault_id:id(9)}} as Awaited<ReturnType<typeof libraryApi.status>>);jest.spyOn(evidenceApi,'projects').mockResolvedValue(page([project(1),project(2)]));jest.spyOn(evidenceApi,'files').mockResolvedValue({...page([]),items:[],revision:1});jest.spyOn(evidenceApi,'notes').mockResolvedValue({...page([]),items:[],revision:1});});
afterEach(()=>jest.restoreAllMocks());
it('asks for an explicit project and preserves literal project names',async()=>{
 jest.mocked(evidenceApi.projects).mockResolvedValue(page([{...project(1),name:'<script>literal</script>'}]));const view=render(<EvidencePage/>);await screen.findByRole('button',{name:/<script>literal/});expect(view.container.querySelector('script')).toBeNull();expect(evidenceApi.files).not.toHaveBeenCalled();
});
it('refuses incomplete Library identity rather than selecting a latest file',async()=>{
 window.location.hash=`#/evidence?file_id=${id(7)}`;const detail=jest.spyOn(libraryApi,'detail');render(<EvidencePage/>);await screen.findByRole('alert');expect(detail).not.toHaveBeenCalled();
});
it('does not overwrite project B when a held project A load completes later',async()=>{
 let release!:(p:Project)=>void;const old=new Promise<Project>(resolve=>{release=resolve;});jest.spyOn(evidenceApi,'detail').mockReturnValueOnce(old).mockResolvedValueOnce(project(2));render(<EvidencePage/>);
 fireEvent.click(await screen.findByRole('button',{name:/Project 1 0 current/}));
 fireEvent.click(screen.getByRole('button',{name:/Project 2 0 current/}));await screen.findByRole('heading',{name:'Project 2'});
 await act(async()=>release(project(1)));expect(screen.getByRole('heading',{name:'Project 2'})).toBeInTheDocument();expect(screen.queryByRole('heading',{name:'Project 1'})).toBeNull();
});
it('unmount cancels a pending project fetch without applying its success',async()=>{
 let release!:(p:Project)=>void;jest.spyOn(evidenceApi,'detail').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));const view=render(<EvidencePage/>);fireEvent.click(await screen.findByRole('button',{name:/Project 1 0 current/}));const signal=jest.mocked(evidenceApi.detail).mock.calls[0][2];view.unmount();expect(signal?.aborted).toBe(true);await act(async()=>release(project(1)));
});

it.each(['add','remove'] as const)('a held %s keeps a newer saved-note selection and its membership',async operation=>{
 const a={...fileFixture(3),original_name:'A.txt'};
 const b={...a,file_id:id(4),version_id:id(4),original_name:'B.txt'};
 const p={...project(1),file_count:2,note_count:1};const updated={...p,revision:2};
 const savedNote=noteFixture(b);
 const detail=jest.spyOn(evidenceApi,'detail').mockResolvedValue(p);
 jest.mocked(evidenceApi.files).mockResolvedValue({...page([]),items:[a,b].map((file,index)=>memberFixture(file,index+1)),revision:1});
 jest.mocked(evidenceApi.notes).mockResolvedValue({...page([]),items:[savedNote],revision:1});
 let release!:(p:Project)=>void;const held=new Promise<Project>(resolve=>{release=resolve;});const mutation=jest.spyOn(evidenceApi,operation).mockReturnValue(held);
 jest.spyOn(libraryApi,'list').mockResolvedValue({files:[a],has_more:false} as Awaited<ReturnType<typeof libraryApi.list>>);
 render(<EvidencePage/>);fireEvent.click(await screen.findByRole('button',{name:/Project 1 0 current/}));await screen.findByRole('button',{name:'Reopen saved note'});
 if(operation==='add'){fireEvent.click(screen.getByRole('button',{name:'Choose from Library'}));fireEvent.click(await screen.findByRole('button',{name:'Add A.txt'}));}
 else{fireEvent.click(screen.getByRole('button',{name:/^A.txt text\/plain/}));fireEvent.click(screen.getByRole('button',{name:'Remove A.txt from collection'}));}
 await waitFor(()=>expect(mutation).toHaveBeenCalledTimes(1));fireEvent.click(screen.getByRole('button',{name:'Reopen saved note'}));
 detail.mockResolvedValue(updated);jest.mocked(evidenceApi.files).mockResolvedValue({...page([]),items:[memberFixture(b,2)],revision:2});jest.mocked(evidenceApi.notes).mockResolvedValue({...page([]),items:[savedNote],revision:2});
 await act(async()=>release(updated));await screen.findByText('Reader fixture B.txt save-enabled');expect(screen.queryByText(/Reader fixture A.txt/)).toBeNull();
});

it.each([true,false])('resolves selected membership beyond the first 50 rows: present=%s',async present=>{
 const selected=fileFixture(3),saved=noteFixture(selected),p={...project(1),file_count:51,note_count:1};
 jest.spyOn(evidenceApi,'detail').mockResolvedValue(p);
 const first={items:Array.from({length:50},(_,i)=>memberFixture(fileFixture(i+10),i+1)),through_id:51,next_after_id:50,has_more:true,total:51,count_basis:'fixed ceiling',revision:1};
 jest.mocked(evidenceApi.files).mockResolvedValue(first);jest.mocked(evidenceApi.notes).mockResolvedValue({...page([]),items:[saved],revision:1});
 render(<EvidencePage/>);fireEvent.click(await screen.findByRole('button',{name:/Project 1 0 current/}));fireEvent.click(await screen.findByRole('button',{name:'Reopen saved note'}));await screen.findByText('Reader fixture File 3.txt save-enabled');
 jest.mocked(evidenceApi.files).mockResolvedValueOnce(first).mockResolvedValueOnce({...first,items:present?[memberFixture(selected,51)]:[],next_after_id:null,has_more:false,total:present?51:50});
 fireEvent.click(screen.getByRole('button',{name:'Refresh project'}));
 await screen.findByText(`Reader fixture File 3.txt ${present?'save-enabled':'save-disabled'}`);await waitFor(()=>expect(evidenceApi.files).toHaveBeenCalledTimes(3));
 expect(jest.mocked(evidenceApi.files).mock.calls[2].slice(0,3)).toEqual([p,51,50]);
});

it('initializes rename from the actual selected project for handoffs and new projects',()=>{
 const props={page:page([project(1)]),selected:project(1),busy:false,onSelect:jest.fn(),onCreate:jest.fn(),onRename:jest.fn(),onNext:jest.fn()};const view=render(<ProjectList {...props}/>);
 expect(screen.getByLabelText('Rename selected project')).toHaveValue('Project 1');view.rerender(<ProjectList {...props} selected={project(2)}/>);expect(screen.getByLabelText('Rename selected project')).toHaveValue('Project 2');
});
