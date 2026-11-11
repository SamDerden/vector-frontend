#!/usr/bin/env python3
"""Read XLSX table sheets using only Python standard library (read-only)."""
import json, posixpath, re, sys, zipfile
import xml.etree.ElementTree as ET
P='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL='http://schemas.openxmlformats.org/package/2006/relationships'
def tag(name): return '{'+P+'}'+name
def column_index(ref):
    letters=re.match(r'[A-Z]+',ref).group()
    result=0
    for c in letters: result=result*26+ord(c)-64
    return result-1
def read(filename):
    with zipfile.ZipFile(filename) as z:
        workbook=ET.fromstring(z.read('xl/workbook.xml'))
        rels=ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        paths={r.attrib['Id']:r.attrib['Target'] for r in rels.findall('{'+REL+'}Relationship')}
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            root=ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.findall(tag('si')):
                shared.append(''.join(t.text or '' for t in si.iter(tag('t'))))
        result={}
        for sheet in workbook.find(tag('sheets')):
            name=sheet.attrib['name']; target=paths[sheet.attrib['{'+R+'}id']]
            path=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl',target))
            root=ET.fromstring(z.read(path))
            records=[]
            for row in root.findall('.//'+tag('sheetData')+'/'+tag('row')):
                cells={}
                for cell in row.findall(tag('c')):
                    index=column_index(cell.attrib['r'])
                    kind=cell.attrib.get('t')
                    val=cell.find(tag('v'))
                    if kind=='inlineStr':
                        inline=cell.find(tag('is'))
                        value=''.join(t.text or '' for t in inline.iter(tag('t'))) if inline is not None else ''
                    elif val is None: value=None
                    elif kind=='s': value=shared[int(val.text)]
                    elif kind in ('str','e'): value=val.text
                    elif kind=='b': value=val.text=='1'
                    else:
                        raw=val.text
                        try: value=float(raw) if '.' in raw or 'e' in raw.lower() else int(raw)
                        except (ValueError,AttributeError): value=raw
                    cells[index]=value
                if cells: records.append(cells)
            if not records: result[name]=[];continue
            headers=records[0]
            result[name]=[{str(h).strip():r.get(i) for i,h in headers.items() if h is not None and str(h).strip()} for r in records[1:] if any(v is not None and v!='' for v in r.values())]
        return result
if __name__=='__main__': print(json.dumps(read(sys.argv[1]),ensure_ascii=False))
