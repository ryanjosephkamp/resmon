import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ComposerChoices, ChoiceSummary, type ChoiceRequest, type ChoicesDescriptor } from '../components/Assistant/ComposerChoices';

const initial: ChoiceRequest = {version:1,runtime:'claude_cli',provider:'claude_code',model:'opus',effort:'high'};
const descriptor: ChoicesDescriptor = {version:1,default_request:initial,default_error:null,
 connections:[{runtime:'claude_cli',provider:'claude_code',label:'Claude Code',implemented:true,available:true,reason:'Local only, not authenticated',effort_supported:true},
 {runtime:'api_key',provider:'openai',label:'OpenAI',implemented:true,available:false,reason:'Key missing',effort_supported:false},
 {runtime:null,provider:'codex',label:'Codex',implemented:false,available:false,reason:'Adapter unavailable',effort_supported:false}],
 claude_aliases:['fable','opus','sonnet','haiku'],claude_efforts:['low','medium','high','xhigh','max'],limitations:'Aliases are not account compatibility.'};
function Harness() {const [value,setValue]=React.useState<ChoiceRequest|null>(initial);return <ComposerChoices descriptor={descriptor} value={value} onChange={setValue}/>;}
test('connection/model/effort controls preserve literal requests and label unavailable adapters',()=>{
 render(<Harness/>);
 expect(screen.getByRole('option',{name:'Codex — adapter unavailable'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Model'),{target:{value:'model;$(literal)'}});
 expect(screen.getByLabelText('Model')).toHaveValue('model;$(literal)');
 fireEvent.change(screen.getByLabelText('Effort'),{target:{value:''}});
 expect(screen.getByLabelText('Effort')).toHaveValue('');
 fireEvent.change(screen.getByLabelText('Connection'),{target:{value:'api_key:openai'}});
 expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument();
 expect(screen.getByText('Effort: Not supported by this adapter')).toBeVisible();
 expect(screen.getByText('Key missing')).toBeVisible();
 expect(screen.getByLabelText('Model')).toHaveValue('');
});
test('a disabled fieldset locks all three choice controls',()=>{
 render(<ComposerChoices descriptor={descriptor} value={initial} onChange={()=>{throw new Error('locked')}} disabled/>);
 for(const label of ['Connection','Model','Effort'])expect(screen.getByLabelText(label)).toBeDisabled();
});
test('unknown and unreadable stored history never invents a request',()=>{
 const {rerender}=render(<ChoiceSummary choices={null}/>);expect(screen.getByText('Historical settings: unknown.')).toBeVisible();
 rerender(<ChoiceSummary choices={{unreadable:true}}/>);expect(screen.getByText('Saved choices: unreadable.')).toBeVisible();
});

test('the selected-answer instance has unique control IDs while ordinary Ask retains its default IDs',()=>{
 const {container}=render(<><ComposerChoices descriptor={descriptor} value={initial} onChange={()=>{}}/><ComposerChoices descriptor={descriptor} value={initial} onChange={()=>{}} legend="Selected answer choices" idPrefix="selected-evidence"/></>);
 const ids=Array.from(container.querySelectorAll('input[id],select[id]')).map(n=>n.id);expect(new Set(ids).size).toBe(ids.length);expect(screen.getByRole('group',{name:'Selected answer choices'}).querySelector('[id^="selected-evidence"]')).not.toBeNull();
});
