import React from 'react';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import NotePanel from '../components/Evidence/NotePanel';
import {Anchor,evidenceApi,EvidenceFile,Project,SavedNote} from '../api/evidence';
const id='11111111-1111-4111-8111-111111111111';const file={file_id:id,version_id:id,vault_id:id,original_name:'Selected.txt'} as EvidenceFile;const project={project_id:id,vault_id:id,revision:2} as Project;
const note={id:1,note_id:id,project_id:id,file_id:id,version_id:id,kind:'passage',body:'old body',quote:'<script>saved literal</script>',page_number:1,revision:1,file,membership_state:'removed'} as SavedNote;
const page={items:[note],through_id:1,next_after_id:null,has_more:false,total:1,count_basis:'selected ceiling'};
afterEach(()=>jest.restoreAllMocks());
it('retains unsaved body on a real conflict response and retries only by another explicit save',async()=>{
 const save=jest.spyOn(evidenceApi,'save').mockRejectedValue(new Error('This project changed.'));
 const props={project,file,anchor:null,notes:null,member:true,onSaved:jest.fn(),onClear:jest.fn(),onNext:jest.fn(),onReopen:jest.fn()};
 const view=render(<NotePanel {...props}/>);fireEvent.change(screen.getByLabelText('Note body'),{target:{value:'Keep my unsaved text'}});fireEvent.click(screen.getByRole('button',{name:'Save note'}));await screen.findByRole('alert');
 expect(screen.getByLabelText('Note body')).toHaveValue('Keep my unsaved text');expect(save).toHaveBeenCalledTimes(1);
 view.rerender(<NotePanel {...props} project={{...project,revision:3}}/>);expect(save).toHaveBeenCalledTimes(1);expect(screen.getByLabelText('Note body')).toHaveValue('Keep my unsaved text');
});
it('keeps removed saved passages literal and allows body editing without creating a new attachment',async()=>{
 const edit=jest.spyOn(evidenceApi,'edit').mockResolvedValue({project:{...project,revision:3},note:{...note,body:'updated',revision:2}});const saved=jest.fn().mockResolvedValue(undefined);const reopen=jest.fn();
 const view=render(<NotePanel project={project} file={file} anchor={null} notes={page} member={false} onSaved={saved} onClear={()=>{}} onNext={()=>{}} onReopen={reopen}/>);
 expect(view.container.querySelector('script')).toBeNull();expect(screen.getByRole('button',{name:'Save note'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Reopen saved passage'}));expect(reopen).toHaveBeenCalledWith(note);
 fireEvent.click(screen.getByRole('button',{name:'Edit saved body'}));fireEvent.change(screen.getByLabelText('Note body'),{target:{value:'updated'}});fireEvent.click(screen.getByRole('button',{name:'Save body'}));
 await waitFor(()=>expect(saved).toHaveBeenCalled());expect(edit).toHaveBeenCalledWith(project,note,'updated');
});
it('does not apply a held saved-note result to a later file selection',async()=>{
 let release!:(value:{project:Project;note:SavedNote})=>void;const held=new Promise<{project:Project;note:SavedNote}>(resolve=>{release=resolve;});jest.spyOn(evidenceApi,'save').mockReturnValue(held);const saved=jest.fn();
 const props={project,file,anchor:null,notes:null,member:true,onSaved:saved,onClear:jest.fn(),onNext:jest.fn(),onReopen:jest.fn()};const view=render(<NotePanel {...props}/>);
 fireEvent.change(screen.getByLabelText('Note body'),{target:{value:'A body'}});fireEvent.click(screen.getByRole('button',{name:'Save note'}));view.rerender(<NotePanel {...props} file={{...file,file_id:'22222222-2222-4222-8222-222222222222'}}/>);
 fireEvent.change(screen.getByLabelText('Note body'),{target:{value:'B unsaved'}});await act(async()=>release({project,note}));expect(saved).not.toHaveBeenCalled();expect(screen.getByLabelText('Note body')).toHaveValue('B unsaved');
});

it('explicitly adopts a refreshed note revision without replacing the unsaved draft',async()=>{
 const edit=jest.spyOn(evidenceApi,'edit').mockRejectedValue(new Error('This note changed.'));
 const props={project,file,anchor:null,notes:page,member:true,onSaved:jest.fn(),onClear:jest.fn(),onNext:jest.fn(),onReopen:jest.fn()};
 const view=render(<NotePanel {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Edit saved body'}));fireEvent.change(screen.getByLabelText('Note body',{exact:true}),{target:{value:'Keep edited draft'}});fireEvent.click(screen.getByRole('button',{name:'Save body'}));await screen.findByRole('alert');
 const refreshed={...note,revision:2,body:'Concurrent saved body'};view.rerender(<NotePanel {...props} project={{...project,revision:3}} notes={{...page,items:[refreshed]}}/>);
 expect(edit).toHaveBeenCalledTimes(1);expect(screen.getByLabelText('Note body',{exact:true})).toHaveValue('Keep edited draft');
 fireEvent.click(screen.getByRole('button',{name:'Keep draft against current revision'}));expect(edit).toHaveBeenCalledTimes(1);expect(screen.getByLabelText('Note body',{exact:true})).toHaveValue('Keep edited draft');
 fireEvent.click(screen.getByRole('button',{name:'Save body'}));await screen.findByRole('alert');expect(edit).toHaveBeenLastCalledWith({...project,revision:3},refreshed,'Keep edited draft');
});

it('focuses a newly mounted editor and identifies its exact saved target',async()=>{
 render(<NotePanel project={project} file={null} anchor={null} notes={page} member={false} onSaved={jest.fn()} onClear={jest.fn()} onNext={jest.fn()} onReopen={jest.fn()}/>);
 expect(screen.queryByLabelText('Note body')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Edit saved body'}));expect(screen.getByLabelText('Note body',{exact:true})).toHaveFocus();expect(screen.getByRole('heading',{name:'Edit saved body · Selected.txt'})).toBeVisible();
});

it.each(['request','refresh'] as const)('preserves text entered while the save %s is pending',async phase=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const save=jest.spyOn(evidenceApi,'save').mockImplementation(async()=>{if(phase==='request')await held;return {project,note};});
 const saved=jest.fn(async()=>{if(phase==='refresh')await held;});const clear=jest.fn();
 render(<NotePanel project={project} file={file} anchor={null} notes={null} member={true} onSaved={saved} onClear={clear} onNext={()=>{}} onReopen={()=>{}}/>);
 fireEvent.change(screen.getByLabelText('Note body'),{target:{value:'Submitted snapshot'}});fireEvent.click(screen.getByRole('button',{name:'Save note'}));
 if(phase==='refresh')await waitFor(()=>expect(saved).toHaveBeenCalled());
 fireEvent.change(screen.getByLabelText('Note body'),{target:{value:'Newer unsaved draft'}});await act(async()=>release());
 expect(save).toHaveBeenCalledWith(project,file,'Submitted snapshot',undefined);expect(screen.getByLabelText('Note body')).toHaveValue('Newer unsaved draft');expect(clear).not.toHaveBeenCalled();expect(screen.getByText('Saved the submitted record. Newer unsaved changes remain in the editor.')).toBeVisible();
});

it('preserves a new passage selected while a previous note save is pending',async()=>{
 let release!:(value:{project:Project;note:SavedNote})=>void;const held=new Promise<{project:Project;note:SavedNote}>(resolve=>{release=resolve;});jest.spyOn(evidenceApi,'save').mockReturnValue(held);const clear=jest.fn();
 const props={project,file,anchor:null,notes:null,member:true,onSaved:jest.fn().mockResolvedValue(undefined),onClear:clear,onNext:jest.fn(),onReopen:jest.fn()};const view=render(<NotePanel {...props}/>);
 fireEvent.change(screen.getByLabelText('Note body'),{target:{value:'Submitted body'}});fireEvent.click(screen.getByRole('button',{name:'Save note'}));
 const anchor={page_number:2,quote:'Later exact passage'} as Anchor;view.rerender(<NotePanel {...props} anchor={anchor}/>);await act(async()=>release({project,note}));
 expect(clear).not.toHaveBeenCalled();expect(screen.getByText('Later exact passage')).toBeVisible();expect(screen.getByLabelText('Note body')).toHaveValue('Submitted body');expect(screen.getByRole('button',{name:'Save passage'})).toBeEnabled();
});
