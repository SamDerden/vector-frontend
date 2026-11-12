import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const file=path.join(root,"data","Навигатор Екб v3.xlsx");
const graph=JSON.parse(fs.readFileSync(path.join(root,"data","navigator_full_graph.json"),"utf8"));
// Read XLSX with Python's standard-library ZIP/XML parser. ExcelJS 4.4 fails
// on this valid workbook while loading workbook.xml (before audit logic runs).
const python=String.raw`
import json, re, sys, zipfile, xml.etree.ElementTree as ET
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
rel_ns='{http://schemas.openxmlformats.org/package/2006/relationships}'
with zipfile.ZipFile(sys.argv[1]) as z:
  strings=[]
  if 'xl/sharedStrings.xml' in z.namelist():
    shared=ET.fromstring(z.read('xl/sharedStrings.xml'))
    strings=[''.join(t.text or '' for t in si.findall('.//m:t',ns)) for si in shared.findall('m:si',ns)]
  workbook=ET.fromstring(z.read('xl/workbook.xml'))
  relationships=ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
  targets={r.attrib['Id']:r.attrib['Target'] for r in relationships.findall(rel_ns+'Relationship')}
  result={}
  for sheet in workbook.findall('m:sheets/m:sheet',ns):
    name=sheet.attrib['name']; rid=sheet.attrib['{'+ns['r']+'}id']; target=targets[rid].lstrip('/')
    if not target.startswith('xl/'): target='xl/'+target
    root=ET.fromstring(z.read(target))
    rows=[]
    for row in root.findall('.//m:sheetData/m:row',ns):
      cells={}
      for cell in row.findall('m:c',ns):
        ref=cell.attrib.get('r',''); letters=re.match(r'[A-Z]+',ref)
        if not letters: continue
        idx=0
        for ch in letters.group(): idx=idx*26+ord(ch)-64
        kind=cell.attrib.get('t',''); v=cell.find('m:v',ns)
        if kind=='inlineStr': value=''.join(t.text or '' for t in cell.findall('.//m:is/m:t',ns))
        elif v is None: value=''
        elif kind=='s': value=strings[int(v.text)]
        elif kind=='b': value='TRUE' if v.text=='1' else 'FALSE'
        else: value=v.text or ''
        cells[idx]=value
      if cells: rows.append([cells.get(i,'') for i in range(1,max(cells)+1)])
    result[name]=rows
  print(json.dumps(result,ensure_ascii=False))
`;
const workbookRows=JSON.parse(execFileSync("python3",["-c",python,file],{encoding:"utf8",maxBuffer:20*1024*1024}));
const errors=[],warnings=[],report={excel:file,graphVersion:graph.meta?.version,sheets:{},comparisons:{}};
const names=["industry","profession","skill","profession_skill","organization","education_program","program_profession","trial","trial_profession","vacancy_snapshot"];
const idColumns={industry:"industry_id",profession:"profession_id",skill:"skill_id",organization:"organization_id",education_program:"program_id",trial:"trial_id"};
const graphGroups={industry:"industries",profession:"professions",skill:"skills",organization:"organizations",education_program:"education_programs",trial:"trials"};
const refs=[["profession","industry_id","industry"],["profession_skill","profession_id","profession"],["profession_skill","skill_id","skill"],["education_program","organization_id","organization"],["program_profession","program_id","education_program"],["program_profession","profession_id","profession"],["trial","organization_id","organization"],["trial_profession","trial_id","trial"],["trial_profession","profession_id","profession"],["vacancy_snapshot","profession_id","profession"]];
function val(v){if(v==null)return "";if(v instanceof Date)return v;if(typeof v==="object"){if("result"in v)return val(v.result);if("text"in v)return val(v.text);}return String(v).trim();}
const data={};
for(const name of names){
  const sheet=workbookRows[name];
  if(!sheet){errors.push("Missing sheet: "+name);continue;}
  const headers=(sheet[0]||[]).map(val);
  if(headers.some(x=>!x)||new Set(headers).size!==headers.length)errors.push("Invalid headers: "+name);
  const rows=sheet.slice(1).map(values=>Object.fromEntries(headers.map((h,i)=>[h,val(values[i])]))).filter(item=>Object.values(item).some(v=>v!==""));
  data[name]=rows;
  report.sheets[name]={rows:rows.length,headers};
}
const sets={};
for(const [name,key] of Object.entries(idColumns)){const rows=data[name]||[];const ids=rows.map(r=>String(r[key]??"").trim());sets[name]=new Set(ids.filter(Boolean));if(ids.some(x=>!x))errors.push(name+": blank "+key);if(sets[name].size!==ids.filter(Boolean).length)errors.push(name+": duplicate "+key);const g=graph[graphGroups[name]]||[];const gid=new Set(g.map(r=>String(r[key]??"").trim()));const onlyExcel=[...sets[name]].filter(x=>!gid.has(x));const onlyGraph=[...gid].filter(x=>!sets[name].has(x));report.comparisons[name]={excel:sets[name].size,graph:gid.size,onlyExcel,onlyGraph};if(onlyExcel.length||onlyGraph.length)warnings.push(name+": Excel/graph ID sets differ (Excel-only "+onlyExcel.length+", graph-only "+onlyGraph.length+")");}
for(const [name,key,target] of refs){for(const row of data[name]||[]){const id=String(row[key]??"").trim();if(id&&!sets[target]?.has(id))errors.push(name+": unknown "+key+"="+id);}}
// Compare market indicators by profession_id, not by row order.
// The graph stores these fields under current_market_state and uses
// salary_median_rub for Excel's salary_median_region.
const marketFields=[
  ["demand_level_region","demand_level_region"],
  ["salary_median_region","salary_median_rub"],
  ["vacancies_count","vacancies_count"],
];
const graphProfessions=new Map((graph.professions||[]).map(p=>[String(p.profession_id??"").trim(),p]));
const marketMismatches=[];
let marketCompared=0;
function comparableMarketValue(value){
  if(value==null)return "";
  const normalized=String(value).trim().replace(/\s/g,"").replace(",",".");
  if(normalized!==""&&Number.isFinite(Number(normalized)))return String(Number(normalized));
  return String(value).trim().toLowerCase();
}
for(const row of data.profession||[]){
  const id=String(row.profession_id??"").trim();
  const profession=graphProfessions.get(id);
  if(!profession)continue; // Already reported in profession ID-set comparison.
  for(const [excelField,graphField] of marketFields){
    if(!Object.hasOwn(row,excelField)){
      errors.push("profession: missing Excel column "+excelField);
      continue;
    }
    const excelValue=row[excelField];
    const graphValue=profession.current_market_state?.[graphField];
    marketCompared++;
    if(comparableMarketValue(excelValue)!==comparableMarketValue(graphValue)){
      marketMismatches.push({profession_id:id,field:excelField,excel:excelValue,graph:graphValue??null});
    }
  }
}
report.comparisons.profession_market={
  compared:marketCompared,
  mismatches:marketMismatches,
  passed:marketMismatches.length===0&&marketCompared===graphProfessions.size*marketFields.length
};
if(marketMismatches.length)errors.push("profession: "+marketMismatches.length+" market-value mismatches");
if(marketCompared!==graphProfessions.size*marketFields.length)errors.push("profession: incomplete market-value comparison ("+marketCompared+"/"+(graphProfessions.size*marketFields.length)+")");
for(const row of data.education_program||[]){for(const key of ["duration_years","specialty_code"]){if(row[key] instanceof Date)errors.push("Excel date in "+key+" for "+row.program_id);}const duration=row.duration_years;if(duration!==""&&!(Number(duration)>0&&Number(duration)<=20))warnings.push("Suspicious duration_years for "+row.program_id+": "+duration);}
for(const row of data.trial||[]){const a=Number(row.age_min),b=Number(row.age_max);if(row.age_min!==""&&row.age_max!==""&&a>b)errors.push("trial age_min>age_max: "+row.trial_id);}
report.errors=errors;report.warnings=warnings;console.log(JSON.stringify(report,null,2));if(errors.length)process.exitCode=1;
