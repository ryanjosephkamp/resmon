"""S16-S20 strict structured output; exact matches remain support-unchecked."""
from __future__ import annotations
from copy import deepcopy
import json
import pytest
from implementation_scripts import evidence as ev, selected_evidence as se
from test_selected_evidence_context import workspace,available,selection,assemble


def answer(request, *, claim='The selected excerpt says something contradicted by its quote.'):
    s=request['payload']['sources'][0];quote=s['text'][:12]
    return {'version':1,'request_sha256':request['request_sha256'],'mode':request['payload']['mode'],'status':'answer',
            'sections':[{'kind':'summary','items':[{'kind':'source_statement','text':claim,
                       'citations':[{'source_id':s['source_id'],'start_codepoint':s['start_codepoint'],
                                     'end_codepoint':s['start_codepoint']+len(quote),'quote':quote}],'note_ids':[]}]}],
            'limitations':['Only selected text was supplied.']}


def test_matching_citation_is_identity_not_truth(workspace,available):
    request,_,_=assemble(workspace,selection(workspace));result=answer(request)
    assert se.validate_result(se.canonical(result),request)==result
    assert 'truth are unchecked' in se.LIMITS


@pytest.mark.parametrize('fault',['request','mode','extra','bool_version','unknown_source','wrong_quote','wrong_offset','no_citation','note_as_source','utf16','wrapper','duplicate','nan','deep','too_many','oversized_quote'])
def test_invalid_results_never_promote_or_repair(workspace,available,fault):
    request,_,_=assemble(workspace,selection(workspace)); result=answer(request)
    item=result['sections'][0]['items'][0];c=item['citations'][0]
    if fault=='request':result['request_sha256']='0'*64
    elif fault=='mode':result['mode']='briefing'
    elif fault=='extra':result['verified_fact']=True
    elif fault=='bool_version':result['version']=True
    elif fault=='unknown_source':c['source_id']='S99'
    elif fault=='wrong_quote':c['quote']='wrong quote!'
    elif fault in ('wrong_offset','utf16'):c['start_codepoint']+=1;c['end_codepoint']+=1
    elif fault=='no_citation':item['citations']=[]
    elif fault=='note_as_source':c['source_id']='N01'
    elif fault=='too_many':result['sections'][0]['items']=[deepcopy(item) for _ in range(37)]
    elif fault=='oversized_quote':c['quote']='a'*1001;c['end_codepoint']=c['start_codepoint']+1001
    raw=se.canonical(result)
    if fault=='wrapper':raw='```json\n'+raw+'\n```'
    elif fault=='duplicate':raw=raw[:-1]+',"version":1}'
    elif fault=='nan':raw=raw[:-1]+',"x":NaN}'
    elif fault=='deep':raw='['*20+raw+']'*20
    with pytest.raises(ev.EvidenceError):se.validate_result(raw,request)


def test_valid_insufficient_evidence_and_literal_hostile_output(workspace,available):
    request,_,_=assemble(workspace,selection(workspace));result=answer(request,claim='<script>never()</script> [link](https://invalid.test)')
    result['status']='insufficient_evidence'
    assert se.validate_result(se.canonical(result),request)['status']=='insufficient_evidence'


@pytest.mark.parametrize('value',['{"a":1,"a":2}','{"a":NaN}','{"a":"\\ud800"}','[1.5]'])
def test_noncanonical_values_refuse(value):
    with pytest.raises(ev.EvidenceError):se.loads(value)


@pytest.mark.parametrize('kind,count,ok',[('sections',6,True),('sections',7,False),('items',36,True),('items',37,False),('citations',72,True),('citations',73,False),('visible',20000,True),('visible',20001,False)])
def test_structured_exact_count_and_visible_bounds(workspace,available,kind,count,ok):
    request,_,_=assemble(workspace,selection(workspace));result=answer(request);item=result['sections'][0]['items'][0];result['limitations']=[]
    if kind=='sections':result['sections']=[{'kind':'questions','items':[]} for _ in range(count)]
    elif kind=='items':result['sections'][0]['items']=[{'kind':'question','text':'q','citations':[],'note_ids':[]} for _ in range(count)]
    elif kind=='citations':item['citations']=[deepcopy(item['citations'][0]) for _ in range(count)]
    else:result['sections'][0]['items']=[{'kind':'question','text':'q'*count,'citations':[],'note_ids':[]}]
    if ok:assert se.validate_result(se.canonical(result),request)==result
    else:
        with pytest.raises(ev.EvidenceError):se.validate_result(se.canonical(result),request)


@pytest.mark.parametrize('fault',['coverage','source','notes','requested','disclosure','response_contract'])
def test_rehashed_corrupt_saved_snapshot_still_refuses(workspace,available,fault):
    request,_,_=assemble(workspace,selection(workspace));p=request['payload']
    if fault=='coverage':p['coverage']['file_count']=5
    elif fault=='source':p['sources'][0]['page_count']=0;p['sources'][0]['source_sha256']=se.sha(se.canonical({k:v for k,v in p['sources'][0].items() if k not in ('source_id','source_sha256')}))
    elif fault=='notes':p['notes']=[{'note_id':'not-a-note'}]
    elif fault=='requested':p['requested']['route_digest']='must-not-enter-public-snapshot'
    elif fault=='disclosure':p['disclosure']['custom_endpoint']=True
    else:p['response_contract']={'invented':'shape'}
    request['request_sha256']=se.sha(se.canonical(p));request['user_prompt']=se.canonical({'request_sha256':request['request_sha256'],'payload':p});request['user_sha256']=se.sha(request['user_prompt'])
    with pytest.raises((ev.EvidenceError,KeyError,TypeError,ValueError)):se.validate_request(request)
