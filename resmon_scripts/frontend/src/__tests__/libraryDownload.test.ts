import {TextEncoder} from 'util';
import {validateInventory,downloadInventory,MAX_INVENTORY_BYTES} from '../lib/libraryDownload';
const vault='11111111-1111-4111-8111-111111111111';
const file={file_id:'11111111-1111-4111-8111-111111111112',version_id:'11111111-1111-4111-8111-111111111113',original_name:'literal.txt',media_type:'text/plain',byte_size:4,sha256:'a'.repeat(64),relative_path:'files/11111111-1111-4111-8111-111111111112/11111111-1111-4111-8111-111111111113.txt',imported_at_utc:'now',paper_links:[{document_id:1,identity_scope:'this app database only',basis:'owner_association'}],availability:'not_checked'};
const document=()=>({version:1,kind:'resmon-library-inventory',vault_id:vault,generated_at_utc:'now',files:[file],limits:['Not a backup']});
const envelope=(inner:unknown=document())=>({version:1,vault_id:vault,format:'json',filename:`resmon-library-${vault}.json`,content_type:'application/json',text:JSON.stringify(inner)});
beforeEach(()=>{Object.assign(global,{TextEncoder});});
it('accepts exact metadata and requests a download only after validation',()=>{
 const value=envelope();expect(validateInventory(value,vault).text).toBe(value.text);
 URL.createObjectURL=jest.fn(()=> 'blob:owned');URL.revokeObjectURL=jest.fn();const click=jest.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
 downloadInventory(value,vault);expect(click).toHaveBeenCalledTimes(1);click.mockRestore();
});
it.each(['vault','filename','format','content_type','inner_vault','absolute_path','private_field','wrong_version','duplicate','association'])('refuses %s without a download',kind=>{
 const doc=document();const value=envelope();
 if(kind==='vault')value.vault_id='wrong';if(kind==='filename')value.filename='../private.json';if(kind==='format')value.format='zip';if(kind==='content_type')value.content_type='text/html';
 if(kind==='inner_vault')doc.vault_id='foreign';
 if(kind==='absolute_path')doc.files=[{...file,relative_path:'/private/source.txt'}];
 if(kind==='private_field')Object.assign(doc,{root_path:'/private/source'});
 if(kind==='wrong_version')doc.files=[{...file,version_id:'not-a-uuid'}];
 if(kind==='duplicate')doc.files=[file,file];
 if(kind==='association')doc.files=[{...file,paper_links:[{document_id:1,identity_scope:'global DOI',basis:'owner_association'}]}];
 value.text=JSON.stringify(doc);expect(()=>validateInventory(value,vault)).toThrow();
});
it('refuses oversize and malformed JSON without truncation',()=>{
 expect(MAX_INVENTORY_BYTES).toBe(8388608);expect(()=>validateInventory({...envelope(),text:' '.repeat(MAX_INVENTORY_BYTES+1)},vault)).toThrow();
 expect(()=>validateInventory({...envelope(),text:'{'},vault)).toThrow();
});
