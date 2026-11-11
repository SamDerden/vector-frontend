import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import fs from 'node:fs';
register(new URL('./security-hooks.mjs', import.meta.url), import.meta.url);
const { validateResponse } = await import('../lib/ai/validate.ts');
const manifest=JSON.parse(fs.readFileSync(new URL('../prompts/manifest.json',import.meta.url),'utf8'));
for(const tier of ['5-8','9-11'] as const) test(`${tier} accepts catalog activity links and rejects invented IDs`,()=>{
 const data={schema_version:manifest[tier].schema.split('@')[1],status:'ok',summary:'Тебе интересно исследовать.',industries:[{industry_id:'ind',why:'Ты любишь природу.',evidence_refs:['q']}],hypotheses:[{profession_id:'prof',industry_id:'ind',why:'Ты любишь природу.',evidence_refs:['q'],activity_links:[{type:'trial_001',evidence_refs:['q']}],match_strength:'moderate',what_to_try:'Попробуй наблюдать.',trial_ids:[],...(tier==='9-11'?{program_ids:[],watch_out:'Проверь свой интерес.'}:{})}],next_step:'Попробуй занятие.',warnings:[],...(tier==='9-11'?{path_note:'Исследуй возможности.'}:{})};
 const ctx={tier,catalogProfessionIds:new Set(['prof']),candidateProfessionIds:new Set(['prof']),industryIds:new Set(['ind']),answerRefs:new Set(['q']),activityTypes:new Set(['trial_001'])};
 const valid=validateResponse(JSON.stringify(data),ctx);assert.equal(valid.success,true,JSON.stringify(valid));
 data.hypotheses[0].activity_links[0].type='invented';assert.equal(validateResponse(JSON.stringify(data),ctx).success,false);
});
