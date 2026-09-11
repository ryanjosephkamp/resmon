import React from 'react';
import { render, fireEvent, screen, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatsPage from '../pages/ChatsPage';
import { chatsApi } from '../api/chats';
import { downloadConversation } from '../lib/conversationDownload';
jest.mock('../api/chats', () => ({ chatsApi: { browse: jest.fn(), detail: jest.fn() } }));
jest.mock('../lib/conversationDownload', () => ({ downloadConversation: jest.fn() }));
const openSession = jest.fn();
let answering = false;
jest.mock('../context/AssistantContext', () => ({
  ...jest.requireActual('../context/AssistantContext'),
  useAssistant: () => ({ openSession, isAnswering: answering, sessionId: 1 }),
}));
const row = (id: number) => ({id,title:`Chat ${id}`,created_at:'stored date',updated_at:'stored date',message_count:1});
const page = (ids=[2,1],more=false) => ({sessions:ids.map(row),through_id:2,next_before_id:more?1:null,has_more:more});
const detail = (id:number) => ({session:row(id), messages:[{id:1,role:'user',content:'<script>saved literal</script>', tool_calls:{unreadable:true}}],snapshot:{message_count:1,captured_at_utc:'observed'},activity_observation:{turn_claimed:false}});
const browse = chatsApi.browse as jest.Mock; const read = chatsApi.detail as jest.Mock;
beforeEach(()=>{jest.clearAllMocks();answering=false;browse.mockResolvedValue(page());read.mockImplementation(async(id:number)=>detail(id));});
it('reads literal text, continues the selected ID and exports explicitly', async()=>{
  render(<ChatsPage/>);fireEvent.click(await screen.findByRole('button',{name:/Chat 2 Created/}));
  expect(await screen.findByText('<script>saved literal</script>')).toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByText('Continue in Ask'));expect(openSession).toHaveBeenCalledWith(2);
  (downloadConversation as jest.Mock).mockResolvedValue(true);
  fireEvent.click(screen.getByText('Export JSON'));
  await screen.findByText(/Download requested/);
  expect(downloadConversation).toHaveBeenCalledWith(2,'json',expect.any(Function));
});
it('holds the refresh bound while paging and resets on filter change',async()=>{
  browse.mockResolvedValueOnce(page([2],true)).mockResolvedValue(page([1]));render(<ChatsPage/>);
  fireEvent.click(await screen.findByText('Older chats'));
  await waitFor(()=>expect(browse).toHaveBeenLastCalledWith('',2,1));
  fireEvent.change(screen.getByLabelText('Filter saved titles'),{target:{value:'%_'}});
  await waitFor(()=>expect(browse).toHaveBeenLastCalledWith('%_',undefined,undefined));
});
it('late list success and error cannot replace a newer filter',async()=>{
  let finish:(v:unknown)=>void=()=>{};browse.mockReturnValueOnce(new Promise(r=>{finish=r;}));
  render(<ChatsPage/>);fireEvent.change(screen.getByLabelText('Filter saved titles'),{target:{value:'new'}});
  await screen.findByRole('button',{name:/Chat 2 Created/});
  await act(async()=>finish(page([99])));expect(screen.queryByText('Chat 99')).not.toBeInTheDocument();
  let reject:(e:Error)=>void=()=>{};browse.mockReturnValueOnce(new Promise((_,r)=>{reject=r;}));
  fireEvent.change(screen.getByLabelText('Filter saved titles'),{target:{value:'old'}});
  fireEvent.change(screen.getByLabelText('Filter saved titles'),{target:{value:'latest'}});
  await act(async()=>reject(new Error('late failure')));expect(screen.queryByText('late failure')).not.toBeInTheDocument();
});
it('late detail and stale export cannot masquerade as the selected chat',async()=>{
  let finish:(v:unknown)=>void=()=>{};read.mockReturnValueOnce(new Promise(r=>{finish=r;}));render(<ChatsPage/>);
  fireEvent.click(await screen.findByRole('button',{name:/Chat 2 Created/}));
  fireEvent.click(screen.getByRole('button',{name:/Chat 1 Created/}));await screen.findByRole('heading',{name:'Chat 1'});
  await act(async()=>finish(detail(2)));expect(screen.queryByRole('heading',{name:'Chat 2'})).toBeNull();
  let current=()=>true;(downloadConversation as jest.Mock).mockImplementation((_id:number,_format:string,c:()=>boolean)=>{current=c;return new Promise(()=>{});});
  fireEvent.click(screen.getByText('Export JSON'));expect(current()).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:/Chat 2 Created/}));expect(current()).toBe(false);
});
it('other active Ask turn blocks continuation while read/export remain available',async()=>{
  answering=true;render(<ChatsPage/>);fireEvent.click(await screen.findByRole('button',{name:/Chat 2 Created/}));
  expect(await screen.findByText('Continue in Ask')).toBeDisabled();expect(screen.getByText('Export JSON')).toBeEnabled();
});
it('missing detail visibly replaces the previous transcript',async()=>{
  render(<ChatsPage/>);fireEvent.click(await screen.findByRole('button',{name:/Chat 2 Created/}));await screen.findByRole('heading',{name:'Chat 2'});
  read.mockRejectedValueOnce(new Error('404 missing'));fireEvent.click(screen.getByRole('button',{name:/Chat 1 Created/}));
  expect(await screen.findByRole('alert')).toHaveTextContent('404 missing');expect(screen.queryByRole('heading',{name:'Chat 2'})).toBeNull();
});
