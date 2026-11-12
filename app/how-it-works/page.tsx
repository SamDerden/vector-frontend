import Link from "next/link";
const sections = [
  {title:"Как работает «Вектор»",file:"8494AF00-0FA1-4E99-A9CD-3BF8214C2185.png",alt:"Схема работы сервиса «Вектор»"},
  {title:"«Билет в будущее» и «Вектор»",file:"269A29CE-1A2B-452F-AE51-EC3F650C6699.png",alt:"Сравнение «Билета в будущее» и «Вектора»"},
  {title:"Как устроена диагностика",file:"F3ED8D7B-2B8B-40EC-91C2-F3AB45E60FDC.png",alt:"Сценарии диагностики для разных возрастов"},
  {title:"Кому помогает «Вектор»",file:"30C95557-7689-46C3-A1B4-079901604B5E.png",alt:"Польза для школьников, педагогов и родителей"},
  {title:"Дальнейшее развитие",file:"1416574A-30D5-4354-A3AC-5A4740ED5DEC.png",alt:"План развития регионального навигатора"}
];
export default function HowItWorksPage(){
return <main style={{minHeight:"100vh",padding:"clamp(18px,4vw,60px)",background:"linear-gradient(130deg,#f1f6ff,#f2edff 55%,#e8fbf5)",color:"#111c48",fontFamily:"inherit"}}>
<header style={{maxWidth:1320,margin:"0 auto 30px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
<Link href="/" style={{fontSize:22,fontWeight:800,color:"#1689db",textDecoration:"none"}}>◀ Вектор</Link><Link href="/" style={{color:"#445579",textDecoration:"none",fontWeight:600}}>На главную</Link>
</header>
<div style={{maxWidth:1320,margin:"0 auto"}}><div style={{textAlign:"center",marginBottom:36}}><h1 style={{fontSize:"clamp(30px,4vw,52px)",margin:"0 0 12px"}}>Как работает «Вектор»</h1><p style={{fontSize:"clamp(16px,2vw,22px)",color:"#536486",margin:0}}>От диагностики — к реальным возможностям Свердловской области</p></div>
<div style={{display:"grid",gap:"clamp(20px,3vw,38px)"}}>{sections.map((s,i)=><section key={s.file} style={{borderRadius:24,overflow:"hidden",background:"rgba(255,255,255,.85)",border:"1px solid #dfe6f6",boxShadow:"0 12px 35px rgba(37,55,105,.08)"}}><img src={`/assets/howitworks/${s.file}`} alt={s.alt} style={{width:"100%",height:"auto",display:"block"}} loading={i===0?"eager":"lazy"}/></section>)}</div>
<div style={{textAlign:"center",padding:"32px 0 12px"}}><Link href="/" style={{display:"inline-block",padding:"14px 30px",borderRadius:50,color:"#fff",fontWeight:700,textDecoration:"none",background:"linear-gradient(100deg,#6234e4,#1656c9,#0ec8aa)"}}>Перейти к диагностике →</Link></div></div></main>}
