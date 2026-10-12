const express=require("express"), http=require("http"), QRCode=require("qrcode"), multer=require("multer"), pdfParse=require("pdf-parse"), mammoth=require("mammoth"), crypto=require("crypto");
const {Server}=require("socket.io"), {Pool}=require("pg");
const app=express(), srv=http.createServer(app), io=new Server(srv);
const up=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});
app.use(express.static(require("path").join(__dirname,"public"))); app.use(express.json({limit:"20mb"}));
const AI_READY=!!process.env.OPENAI_API_KEY, DB_READY=!!process.env.DATABASE_URL;
const MODEL=process.env.OPENAI_MODEL||"gpt-5.6-luna";
let pool=null;if(DB_READY)pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const mem={history:[],vocabAttempts:[]};
async function initDB(){if(!pool)return;await pool.query(`create table if not exists exam_history(id bigserial primary key, school text, grade text, mode text, source_hash text, qtype text, question jsonb, created_at timestamptz default now())`);await pool.query(`create table if not exists vocab_attempts(id bigserial primary key, student text, class_name text, set_name text, total int, correct int, wrong_words jsonb, created_at timestamptz default now())`)}initDB().catch(console.error);
const grammarGroups={
"기초 문장": ["BE동사 현재형(am/is/are)","BE동사 과거형(was/were)","일반동사 현재형","일반동사 과거형","의문문·부정문","명령문","There is/are","감탄문","1형식","2형식","3형식","4형식","5형식"],
"명사·대명사·관사": ["명사의 단수·복수","셀 수 있는/없는 명사","관사(a/an/the)","인칭대명사","소유격·소유대명사","재귀대명사","부정대명사","지시대명사","one/ones","it 용법","가주어 it","비인칭주어 it"],
"시제·태": ["현재시제","과거시제","미래시제","현재진행","과거진행","미래진행","현재완료","과거완료","미래완료","현재완료진행","과거완료진행","수동태 기본","4형식 수동태","5형식 수동태","조동사 수동태","완료 수동태"],
"조동사": ["can/could","may/might","must/have to","should/ought to","will/would","had better","used to","would like to","조동사+have p.p.","추측의 조동사"],
"준동사": ["to부정사 명사적 용법","to부정사 형용사적 용법","to부정사 부사적 용법","의문사+to부정사","too...to","enough to","동명사","동명사 vs to부정사","분사(현재분사/과거분사)","분사구문","완료 분사구문","독립 분사구문","with+O+분사"],
"관계사·접속사": ["관계대명사 who","관계대명사 which","관계대명사 that","관계대명사 what","관계대명사 whose","관계대명사 목적격 생략","관계대명사 계속적 용법","전치사+관계대명사","관계부사 when","관계부사 where","관계부사 why","관계부사 how","복합관계대명사","복합관계부사","명사절 접속사 that","whether/if 명사절","간접의문문","부사절 접속사","상관접속사"],
"형용사·부사·비교": ["형용사/부사 구별","빈도부사","enough 위치","원급 비교","비교급","최상급","비교급 강조","the 비교급, the 비교급","배수 표현","비교급 관용표현"],
"일치·특수구문": ["주어·동사 수일치","시제 일치","대명사 일치","가정법 과거","가정법 과거완료","혼합가정법","I wish 가정법","as if 가정법","도치","부정어 도치","Only 도치","강조구문 It is...that","생략","대용","동격 that","병렬구조","부정사 의미상 주어","동명사 의미상 주어"],
"동사 핵심": ["지각동사","사역동사","준사역동사 help","5형식 목적격보어","수여동사","자동사/타동사","동사+전치사","동사+동명사","동사+to부정사","목적어로 that절","목적보어 형용사"],
"전치사·기타": ["시간 전치사","장소 전치사","전치사+동명사","접속사 vs 전치사","수량형용사 many/much/few/little","each/every/all/both","부분부정","전체부정","부정어","화법 전환","특수 의문문","부가의문문"]};
const mockTypes=["목적","심경/분위기","주장","밑줄 의미/함의","요지","주제","제목","내용 일치","내용 불일치","어법","문맥상 어휘","빈칸 추론","무관한 문장","글의 순서","문장 삽입","요약문 완성","지칭 추론","장문 제목","장문 어휘","장문 순서","장문 내용 일치/불일치"];
const simulGroups={"독해 전 유형":mockTypes,"학교 내신형":["본문 빈칸","본문 어휘 변형","본문 어법 변형","문장 배열","영영풀이","어휘 관계","문장 전환","조건 영작","서술형 영작","내용 요약 서술형","문법 오류 고쳐쓰기","우리말에 맞게 영작","주어진 단어 배열","대화문 완성","교과서 핵심문장"],"문법 개별 출제":["문법 종합","관계사","시제","수동태","준동사","가정법","비교","접속사","수일치","5형식"]};
app.get("/api/status",(q,s)=>s.json({ai:AI_READY,db:DB_READY,version:"3.3.0-workbook"}));
app.get("/api/config",(q,s)=>s.json({grammarGroups,grammarFormats:["5지선다","괄호 양자택일","어법 오류 찾기","고쳐쓰기","영작","문장 배열","문장 형식 판단","빈칸 완성"],mockTypes,simulGroups}));
async function extractUploadedFile(req,res){try{if(!req.file)return res.status(400).json({error:"파일이 없습니다."});const name=String(req.file.originalname||"").toLowerCase();const mime=String(req.file.mimetype||"").toLowerCase();let text="";if(name.endsWith(".pdf")||mime==="application/pdf"){const d=await pdfParse(req.file.buffer);text=d.text||""}else if(name.endsWith(".docx")||mime.includes("wordprocessingml")){const d=await mammoth.extractRawText({buffer:req.file.buffer});text=d.value||""}else if(name.endsWith(".txt")||name.endsWith(".md")||mime.startsWith("text/")){text=req.file.buffer.toString("utf8")}else{return res.status(400).json({error:"지원 파일 형식은 PDF, DOCX, TXT, MD입니다."})}if(!text.trim())return res.status(400).json({error:"파일에서 텍스트를 추출하지 못했습니다. 스캔 PDF라면 텍스트가 포함된 PDF 또는 복사 가능한 원문을 사용해주세요."});res.json({text})}catch(e){res.status(500).json({error:"파일 텍스트 추출에 실패했습니다: "+e.message})}}
app.post("/api/extract/file",up.single("file"),extractUploadedFile);
app.post("/api/extract/pdf",up.single("file"),extractUploadedFile);
async function aiText(instructions,input){if(!AI_READY)throw Error("OPENAI_API_KEY가 연결되지 않았습니다. Render 환경변수에 키를 추가해주세요.");const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Authorization":"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,instructions,input,reasoning:{effort:"medium"}})});const j=await r.json();if(!r.ok)throw Error(j.error?.message||"OpenAI API 오류");return j.output_text||j.output?.flatMap(x=>x.content||[]).map(x=>x.text||"").join("")||""}
function cleanJson(t){const a=t.indexOf("{");const b=t.lastIndexOf("}");if(a<0||b<a)throw Error("AI 결과를 JSON으로 읽지 못했습니다.");return JSON.parse(t.slice(a,b+1))}
function hash(t){return crypto.createHash("sha256").update(String(t||"")).digest("hex").slice(0,24)}
async function recentHistory(school,mode){if(pool){const r=await pool.query("select question,qtype from exam_history where mode=$1 and ($2='' or school=$2) order by created_at desc limit 80",[mode,school||""]);return r.rows}return mem.history.filter(x=>x.mode===mode&&(!school||x.school===school)).slice(0,80)}
async function saveHistory(meta,questions){for(const q of questions){if(pool)await pool.query("insert into exam_history(school,grade,mode,source_hash,qtype,question) values($1,$2,$3,$4,$5,$6)",[meta.school||"",meta.grade||"",meta.mode,meta.sourceHash,q.type||"",JSON.stringify(q)]);else mem.history.unshift({...meta,qtype:q.type||"",question:q,created_at:new Date().toISOString()})}}
app.post("/api/analyze-school",async(req,res)=>{try{const b=req.body||{};const out=await aiText("너는 한국 중고등학교 영어 내신 시험지 분석가다. 평가나 추측보다 실제 입력 시험지에서 확인되는 형식만 분석한다.",`학교: ${b.school||"미입력"}\n학년: ${b.grade||""}\n다음 기출 시험지를 분석해서 한국어로 간결하게 정리하라. 반드시 ① 객관식/서술형 구성 ② 반복되는 발문/문항 유형 ③ 선택지 특징 ④ 본문 변형 방식 ⑤ 문법/어휘 출제 방식 ⑥ 새 시험을 만들 때 따라야 할 형식 규칙 순서로 작성하라.\n\n${String(b.text||"").slice(0,50000)}`);res.json({analysis:out})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/generate",async(req,res)=>{try{const b=req.body||{},mode=b.mode;b.grammarText=String(b.grammarText??b.passage??"");b.translationText=String(b.translationText??b.passage??"");if(!["weekly","simul"].includes(mode))return res.status(400).json({error:"잘못된 모드입니다."});const school=mode==='simul'?(b.school||""):"";const hist=await recentHistory(school,mode);const old=hist.map((x,i)=>`${i+1}. [${x.qtype||""}] ${x.question?.prompt||""} / 정답근거:${x.question?.evidence||""}`).join("\n").slice(0,18000);
const base=`너는 JONG-RO M ENGLISH 시험 출제 엔진이다. 한국 중고등학교 영어시험을 만든다. 반드시 유효한 JSON 객체만 출력한다. 스키마: {"title":"...","questions":[{"type":"유형","prompt":"발문","passage":"필요할 때만 원문/문장","options":["선택지1","선택지2","선택지3","선택지4","선택지5"],"answer":1,"answerText":"서술형이면 모범답안","evidence":"정답 근거","sourceKind":"weekly 모의고사면 mock, 문법/예문이면 grammar, WEEKLY 해석 테스트면 translation, SIMUL이면 simul","sourceExcerpt":"WEEKLY mock 문항이면 출제에 사용한 원자료의 정확한 원문 구간, 아니면 빈 문자열","teacherGuide":{"flow":"전체 논리 흐름 한 줄","roles":["문장별 역할"],"clues":["연결 단서"],"structure":["논리 구조 태그"]}}]}. 객관식은 정확히 5지선다, 정답은 1~5 숫자. 서술형은 options=[] 가능. 같은 정답 패턴만 반복하지 말 것. 제공되지 않은 원문 사실을 지어내지 말 것. 과거 출제와 발문만 바꾼 실질적 동일문항, 동일 정답근거, 동일 오답논리를 피하라.

[선지 설계 엔진]
목표는 단순히 헷갈리게 하는 것이 아니라 학생의 정확한 독해·문법 이해를 변별하는 것이다. 먼저 각 문항의 평가 능력과 정답 근거를 확정한 뒤 선지를 만든다. 정답은 지문의 핵심을 정확히 재진술하되 가능하면 원문을 그대로 복사하지 않는다. 오답은 다음 전략 중 문항에 적합한 서로 다른 전략을 사용한다: 부분 일치형(사실 일부는 맞지만 핵심을 대표하지 못함), 범위 왜곡형(some/all, often/always, 특정/일반 등 범위 미세 변형), 인과관계 왜곡형, 주체·대상·비교대상 교체형, 조건 누락·변형형, 초점 이동형(언급은 되었으나 중심이 아님), 논리 반전형, 과잉 추론형(그럴듯하지만 지문만으로 단정 불가), 상식 유혹형(현실적으로 가능하지만 지문 근거 없음), 키워드 유혹형(지문 어휘를 사용하되 전체 의미가 틀림), 관계 왜곡형(비교·대조·예시·양보·문제해결 관계 오독), 근접개념형, 문단 혼합형(서로 다른 문단 사실을 잘못 결합), 정답 근접형(대부분 맞지만 결정적 한 요소가 틀림).

[유형별 우선 전략]
주제·요지·제목·주장: 부분 일치/초점 이동/범위 왜곡/과잉 일반화/정답 근접형을 우선한다. 내용 일치·불일치·지칭: 주체·대상 교체/조건·수치·시점 변형/인과 변형/문단 혼합을 우선한다. 빈칸·함의: 가까운 개념/논리 관계 왜곡/문맥 방향 반전/정답 근접형을 우선한다. 순서·삽입·무관문장·요약: 연결어·지시어·논리 전개·문단 역할을 실제로 이해해야 구별되게 한다. 어휘: 품사가 안 맞는 황당한 단어가 아니라 같은 의미장·문맥에서 경쟁 가능한 어휘를 사용한다. 어법·문법: 목표 문법 체계 안의 실제 학습자 혼동을 사용하고, 목표 외의 우연한 문법 오류를 힌트로 만들지 않는다. 관계사는 who/which/that/what/whose/where 등 실제 혼동군, 시제는 문맥의 시간관계, 준동사는 동사별 결합과 의미 차이처럼 해당 문법의 오개념을 반영한다.

[고난도 핵심 유형 출제 규칙 — 절대 적용]
다음 유형은 단순 형식 변환이나 표면 단서만으로 풀리는 문제를 금지한다: 빈칸 추론, 무관한 문장, 문장 삽입, 글의 순서, 요약문 완성, 어법, 문맥상 어휘.

1. 빈칸 추론
- 먼저 글 전체의 MAIN CLAIM / 핵심 결론 / 핵심 인과·대조 관계를 내부적으로 확정한다.
- 빈칸은 가능한 한 글의 핵심 의미를 담는 문장 또는 핵심 명제 부분에 설정한다. 단순 예시, 고유명사, 주변 세부사항, 숫자, 문맥 없이도 맞힐 수 있는 표현에는 빈칸을 만들지 않는다.
- 빈칸 앞뒤 최소 2개 이상의 논리 단서를 종합해야 정답을 고를 수 있게 한다. 바로 앞 문장의 동의어만 찾으면 풀리는 문제를 금지한다.
- 빈칸이 문장 전체라면 정답은 핵심 명제의 정확한 paraphrase가 되게 하고, 오답은 같은 주제·비슷한 어휘를 공유하되 논리 방향/범위/인과/초점 중 하나가 미세하게 틀리게 한다.
- 핵심 문장에 적절한 빈칸을 만들 수 없으면 억지로 빈칸 문제를 만들지 말고 다른 출제 포인트를 선택한다.

2. 무관한 문장
- 단순히 소재가 전혀 다른 문장을 끼워 넣는 방식을 금지한다.
- 오답 후보 문장들도 같은 주제·핵심 어휘·문체를 공유하도록 하고, 정답 문장은 국소적으로는 자연스럽지만 글 전체의 논리 진행, 초점, 인과, 시간 순서, 일반→구체 관계 중 하나를 깨뜨리게 한다.
- 특정 단어 하나만 보고 제거할 수 없고 앞뒤 문장 관계를 함께 읽어야 판단되게 한다.

3. 문장 삽입
- 주어진 문장에 지시어, 대명사, 관사, 반복/동의 표현, 연결어, 논리적 전제-결과 중 최소 2개의 배치 단서를 확보한다.
- 한 단어 반복만으로 위치가 즉시 드러나는 문제를 피한다.
- 최소 2개 위치가 겉보기에는 가능해 보이지만 담화 결속성과 논리 전개를 보면 하나만 정답이 되게 한다.

4. 글의 순서
- A/B/C 각 단락에 서로 이어지는 OLD→NEW 정보, 지시어, 연결어, 원인→결과, 주장→근거 등의 연쇄를 설계/확인한다.
- First/Second/Finally 같은 노골적 표지 하나만으로 순서가 결정되는 문제를 피한다.
- 첫 단락 하나만 찾으면 나머지가 자동 결정되는 지나치게 단순한 배열을 피하고 최소 두 개의 연결 관계를 추론하게 한다.

5. 요약문 완성
- 원문의 한 문장을 그대로 베껴 빈칸으로 만들지 않는다. 글 전체의 핵심 관계를 상위 개념으로 압축한 새로운 요약문을 만든다.
- (A)/(B)는 서로 독립적인 단어 맞히기가 아니라 글의 핵심 관계를 함께 이해해야 결정되게 한다.
- 오답 조합은 원문에 등장한 단어를 단순 섞는 것이 아니라 범위/인과/대조/주체 관계를 미세하게 왜곡한다.

6. 어법
- 철자, 단복수처럼 지나치게 표면적인 오류만으로 답이 보이게 하지 않는다. 해당 지문의 실제 구문과 의미관계를 이해해야 판단되는 포인트를 우선한다.
- 수일치, 시제, 태, 관계사, 준동사, 분사, 병렬, 대명사, 접속 구조 등 실제 혼동 가능한 후보를 사용하되 한 문제에서 목표 외 우연한 오류를 만들지 않는다.
- 밑줄 주변만 읽어도 무조건 답이 보이는 형태를 피하고 가능한 경우 선행사·주절·시간관계 등 문맥을 확인하게 한다.

7. 문맥상 어휘
- 정답/오답은 같은 품사이며 문법적으로 모두 들어갈 수 있게 한다.
- 반의어 하나가 너무 노골적으로 튀는 방식보다 글의 논리 방향, 태도, 인과관계를 읽어야 구별되는 근접 어휘를 우선한다.
- 단어 자체의 난삽함이 아니라 문맥 적합성으로 난도를 만든다.

이 7개 유형은 생성 후 별도 TYPE QUALITY GATE를 통과해야 한다. 핵심 추론 없이 표면 단서만으로 풀리거나 정답이 뻔한 문항은 최종 결과로 사용하지 않는다.

[교사용 논리 분석]
지문이 있는 독해 문항에는 teacherGuide를 작성한다. flow에는 글 전체 전개를 MAIN→SUPPORT, GENERAL→SPECIFIC, OLD→NEW, CAUSE→EFFECT, PROBLEM→SOLUTION, CLAIM→EVIDENCE, CONTRAST, CONCESSION→CLAIM, QUESTION→ANSWER, PROCESS/SEQUENCE, CONDITION→RESULT, PURPOSE→METHOD, PHENOMENON→EXPLANATION, EXAMPLE→INFERENCE, EXPECTATION→REALITY, COMMON VIEW→CORRECTION, SUMMARY/CONCLUSION 등의 태그를 이용해 한 줄로 요약한다. roles에는 문장 번호별 역할을 한국어로 간결히 적고, clues에는 연결사·지시어·반복어/동의어·관사 a→the·시제·대명사 지시·논리 연결 등 실제 연결 단서를 적는다. structure에는 핵심 MAIN/SUPPORT 및 GENERAL/SPECIFIC 등 구조를 적는다. 근거가 없는 구조 태그는 억지로 붙이지 않는다. 문법 단독 문항은 teacherGuide를 비워도 된다.

[WEEKLY DUAL MODE — 최우선 규칙]
WEEKLY 모의고사 출제에는 original(원문 그대로)과 transform(변형 출제) 두 모드가 있다. 요청된 모드를 반드시 지키며 임의로 바꾸지 않는다.
- original: sourceExcerpt에는 사용한 원자료의 정확한 연속 원문을 기록한다. 주제/제목/요지/주장/내용일치/함의/지칭 등은 passage를 sourceExcerpt와 글자 그대로 동일하게 유지한다. 빈칸/어법/어휘/삽입/순서처럼 문제 성립에 표시가 필요한 유형만 해당 위치를 최소한으로 표시·치환할 수 있고, 그 밖의 문장·어순·표현은 고치거나 요약하지 않는다. 문제의 발문, 평가 포인트, 선지는 새롭게 설계할 수 있다.
- transform: 아래 WEEKLY TRANSFORMATION LENGTH LOCK을 적용한다. 요약/축약은 금지하지만 표현·구조와 평가 포인트의 적극적인 변형은 허용한다.

[WEEKLY TRANSFORMATION LENGTH LOCK — 최우선 규칙]
WEEKLY의 모의고사 변형은 새 문제를 만드는 것이지 원문을 요약해 짧은 지문으로 바꾸는 작업이 아니다. 이 규칙은 WEEKLY 모의고사 변형 문항에 절대 적용한다.
1. 모의고사 변형 문항은 sourceKind를 반드시 "mock"으로 표시하고, sourceExcerpt에는 실제 출제에 사용한 원자료의 완전한 원문 구간을 글자 그대로 넣는다.
2. passage를 요약문, 개요, 핵심문장 몇 개만 남긴 축약본으로 새로 쓰는 것을 금지한다. 원자료가 길다는 이유로 문장 수를 줄이지 않는다.
3. 변형 passage의 완전한 문장 수는 sourceExcerpt의 완전한 문장 수보다 적어서는 안 된다. 문제 유형상 빈칸/삽입/순서처럼 표시 방식이 달라져도 원문 문장 자체를 삭제하여 문장 수를 줄이지 않는다.
4. 변형 passage의 문자량은 sourceExcerpt의 75% 미만으로 줄어들어서는 안 된다. 빈칸 기호, 번호, 배열표시 등 문제 성립을 위한 치환은 허용하지만 요약·축약을 위한 삭제는 금지한다.
5. 원문을 그대로 유지할 필요는 없다. WEEKLY의 목적에 맞게 평가 포인트, 발문, 빈칸, 어휘/어법 포인트, 순서/삽입 구조, 선지는 새롭게 변형할 수 있다. 그러나 변형은 "충분한 길이의 지문" 위에서 이루어져야 한다.
6. 원자료의 한 지문이 5문장 이상이면 학생용 passage도 최소 5개의 완전한 문장을 가져야 한다. 5문장 미만의 짧은 원자료는 원문보다 문장 수를 줄이지 않는다.
7. 원문 일부만 떼어 2~4문장짜리 미니 지문으로 만든 뒤 새 문제라고 제시하는 것을 금지한다. 원자료 전체의 논리 흐름과 문맥을 유지할 만큼 충분한 구간을 사용한다.
8. 이 규칙을 만족시키지 못하는 문항은 생성하지 말고 다른 평가 포인트로 다시 만든다.

[WEEKLY STANDALONE GRAMMAR ENGINE — 최우선 규칙]
WEEKLY 문법 문제는 배운 지문이 없어도 선택한 문법 사항만으로 독립 생성할 수 있다.
1. grammarSource=independent이면 수업 지문을 출제 근거로 요구하지 않는다. 선택된 문법 사항과 학년·난이도에 맞는 자연스러운 새 영어 예문을 직접 만들어 문제를 출제한다.
2. 새 예문은 특정 교재/기출 문장을 복제하지 말고 독립적인 문장으로 만든다. sourceKind는 반드시 grammar, sourceExcerpt는 빈 문자열로 둔다.
3. 선택하지 않은 문법 사항을 정답 근거로 삼지 않는다. 우연한 철자/어휘/다른 문법 오류 때문에 정답이 노출되지 않게 한다.
4. grammarSource=passage이면 입력된 배운 지문/예문을 활용해 문제를 만들고, 원문의 의미를 불필요하게 훼손하지 않는다.
5. grammarSource=mixed이면 독립 생성 문법 문제와 배운 지문 활용 문법 문제를 섞되, 입력 지문이 없으면 독립 생성으로 처리한다.
6. 5지선다형은 기존 DISTRACTOR ENGINE과 Choice QA를 그대로 적용하며, 목표 문법 안에서 실제 학생이 혼동할 만한 오답을 만든다.
7. 학년과 난이도에 맞지 않는 과도하게 복잡한 어휘 때문에 문법 판단이 방해되지 않게 한다.

[WEEKLY TRANSLATION TEST ABSOLUTE LOCK — 최우선 규칙]
WEEKLY 해석 테스트는 학생이 이미 배운 지문의 실제 영어 문장을 우리말로 해석하는 서술형 시험이다.
1. 해석 테스트 문항은 sourceKind를 반드시 "translation"으로 표시한다.
2. passage와 sourceExcerpt에는 수업 지문/예문에 실제 존재하는 영어 문장을 글자 그대로 넣는다. 새로운 영어 문장을 만들거나 원문을 요약·축약·의역·문법 수정·동의어 치환하지 않는다.
3. options는 반드시 빈 배열 []로 하고, prompt는 "다음 문장을 우리말로 해석하시오."로 한다.
4. answerText에는 자연스럽고 정확한 한국어 모범 해석을 작성한다. 핵심 의미관계, 수식관계, 대명사 지시, 논리관계를 빠뜨리지 않는다.
5. 한 문항은 원칙적으로 완전한 한 문장으로 출제한다. 지나치게 짧아 해석 평가 가치가 없는 문장은 피한다.
6. key 모드는 문법·구문·핵심 내용상 학습 가치가 높은 문장을 우선하고, random 모드는 지문 앞/중간/뒤에서 편중되지 않게 고른다.
7. 같은 문장을 중복 출제하지 않는다. 원문에 없는 문장은 절대 출제하지 않는다.

[SIMUL SOURCE TEXT ABSOLUTE LOCK — 최우선 규칙]
SIMUL의 시험범위 원문은 출제 재료가 아니라 보존 대상이다. 어떤 다른 지시보다 이 규칙이 우선한다.
1. 시험범위 원문을 요약, 축약, 의역, 문장 삭제, 문장 추가, 표현 다듬기, 동의어 치환하여 passage에 제시하는 것을 금지한다.
2. 주제·제목·요지·주장·내용일치/불일치·함의·지칭 등 원문 자체의 변형이 필요 없는 유형은 passage에 시험범위의 연속된 원문을 글자 그대로 사용한다.
3. 빈칸·어법·어휘·문장삽입·순서·무관문장처럼 문제 성립을 위해 조작이 필수인 유형만 필요한 위치를 최소한으로 조작할 수 있다. 이 경우에도 나머지 원문 문장과 어순을 임의로 고치거나 줄이지 않는다.
4. 길다는 이유로 원문을 줄이지 않는다. 토큰 한계가 있으면 요약하지 말고 해당 원문 중 출제에 필요한 완전한 연속 구간을 그대로 선택한다.
5. 원문에 없는 설명문/요약문을 새 passage처럼 만들어 학생에게 제시하지 않는다.
6. 선지와 발문은 새로 만들 수 있지만 정답 근거는 반드시 보존된 시험범위 원문에 있어야 한다.
7. 위 규칙을 지키지 못하는 문항은 생성하지 말고 다른 문항을 만든다.

[공정성 규칙]
정답과 오답의 길이·문체·구체성·문법적 완성도를 평행하게 맞춘다. 정답만 유난히 길거나 자세하거나 원문과 어휘가 겹쳐 티 나게 하지 않는다. always/never 같은 절대어, 단순 부정, 엉뚱한 소재만으로 쉽게 제거되는 오답을 남발하지 않는다. 모든 오답은 왜 틀렸는지 지문 또는 목표 문법으로 설명 가능해야 하며 정답은 정확히 하나여야 한다. 네 오답이 동일한 함정 논리를 반복하지 않게 한다. 난이도를 올릴 때는 어려운 단어를 무작정 쓰지 말고 정답과 오답 사이의 의미 거리를 줄인다.`;
let prompt;if(mode==='weekly'){const weeklyMockMode=b.mockMode==='original'?'original':'transform';const weeklyModeRule=weeklyMockMode==='original'?`[WEEKLY 모의고사 모드: 원문 그대로] 모의고사 문항의 sourceExcerpt는 원자료의 정확한 연속 구간이어야 한다. 원문 변형이 필요 없는 유형은 passage를 sourceExcerpt와 글자 그대로 동일하게 사용한다. 요약·축약·의역·문장 삭제·문장 추가·동의어 치환을 금지한다. 빈칸/어법/어휘/삽입/순서처럼 문제 성립상 조작이 필수인 유형만 필요한 위치를 최소 조작하고 나머지는 원문 그대로 둔다. 발문·평가 포인트·선지는 새로 설계한다.`:`[WEEKLY 모의고사 모드: 변형 출제] 지문을 적극적으로 변형할 수 있으나 요약·축약은 절대 금지한다. passage 문장 수는 sourceExcerpt보다 적을 수 없고 문자량은 75% 이상이어야 하며, 원자료가 5문장 이상이면 최소 5문장을 유지한다. 충분한 전체 문맥 위에서 평가 포인트·표현·문제 유형·선지를 새롭게 설계한다.`;prompt=`WEEKLY TEST를 생성하라. 대상 ${b.grade}, 난이도 ${b.difficulty}, 목표 총 ${b.total}문항.\n${weeklyModeRule}\n문법 선택: ${(b.grammar||[]).join(', ')}\n문법 형식: ${(b.grammarFormats||[]).join(', ')}\n문법 목표 문항수: ${b.grammarCount||0}\n문법 출제 기준: ${b.grammarSource==='passage'?'배운 지문/예문 활용':b.grammarSource==='mixed'?'독립 생성 + 배운 지문 혼합':'선택 문법만으로 독립 생성'}\n해석 테스트 목표 문항수: ${b.translationCount||0}\n해석 테스트 출제 방식: ${b.translationMode==='random'?'지문 전체에서 고르게':'핵심 문장 위주'}\n문법용 수업 지문/예문:\n${String(b.grammarText||'').slice(0,35000)}\n\n해석 테스트용 배운 지문:\n${String(b.translationText||'').slice(0,35000)}\n\n모의고사 변형 유형: ${(b.mockTypes||[]).join(', ')}\n유형별 정확한 문항 수: ${JSON.stringify(b.mockTypeCounts||{})}\n모의고사 변형 목표 문항수: ${b.mockCount||0}\n모의고사 원자료:\n${String(b.mockText||'').slice(0,35000)}\n\n규칙: 선택한 문법만 문법문제로 출제한다. 문법 목표 문항수가 1 이상이면 정확히 그 수만큼 sourceKind="grammar"인 문법 문항을 포함한다. grammarSource=independent이면 배운 지문이 비어 있어도 반드시 선택 문법만으로 새 예문과 새 문제를 생성하며 sourceExcerpt=""로 둔다. grammarSource=passage이면 입력 지문/예문을 활용한다. grammarSource=mixed이면 두 방식을 혼합한다. 모의고사 문항은 반드시 sourceKind="mock" 및 sourceExcerpt=출제에 사용한 원자료의 정확한 원문 구간을 기록한다. 위에서 지정한 WEEKLY 모의고사 모드 규칙을 절대 우선한다. 모의고사 자료가 있으면 원본 문항을 살짝 고치거나 선지만 교체하는 방식은 금지한다. 원자료의 지문과 핵심 내용을 출제 재료로 사용하되, 원문 문항의 발문·정답 위치·정답 근거 포인트·오답 논리를 그대로 재사용하지 말고 새로운 평가 포인트를 찾아 독립적인 새 문항으로 재설계한다. 가능하면 원본과 다른 선택 유형(빈칸/순서/삽입/어휘/어법/내용일치/요약/제목 등)으로 전환하고, 같은 유형을 선택했더라도 묻는 핵심과 선지 논리를 새로 설계한다. 학생이 원본 문제를 외웠다는 이유만으로 정답을 맞힐 수 없어야 한다. 단, 지문 자체를 변형해야 하는 유형 외에는 원문 사실과 의미를 훼손하지 않는다. 해석 테스트 목표 문항수가 1 이상이면 정확히 그 수만큼 sourceKind="translation"인 해석 문항을 포함하고 WEEKLY TRANSLATION TEST ABSOLUTE LOCK을 적용한다. 해석 테스트는 문법/모의고사 문항과 별도 문항으로 센다.`}else{prompt=`SIMUL TEST를 생성하라. 학교 ${b.school||''}, ${b.grade}, ${b.term||''}, 총 ${b.total}문항, 난이도 ${b.difficulty}.\n학교 기출 분석/추가 지시:\n${String(b.style||'').slice(0,15000)}\n\n기출 시험지 원문(형식 참고):\n${String(b.pastText||'').slice(0,25000)}\n\n이번 시험범위 지문(내용 출처):\n${String(b.rangeText||'').slice(0,50000)}\n\n선택 출제 유형: ${(b.types||[]).join(', ')}\n유형별 정확한 문항 수: ${JSON.stringify(b.typeCounts||{})}\n서술형 비율: ${b.written}.\n규칙: 학교 기출은 내용 복사가 아니라 발문/선택지/서술형/문항 구성의 형식을 분석해 재현한다. 문제 내용과 정답 근거는 반드시 이번 시험범위에서 가져온다. 시험범위 원문 보존은 선택사항이 아니라 절대 규칙이다. 원문 변형이 필요 없는 유형은 passage를 시험범위의 연속된 원문과 글자 그대로 일치시켜라. 요약·축약·의역·문장 삭제로 새 지문을 만들지 마라. 빈칸/어법/어휘/삽입/순서/무관문장처럼 유형상 조작이 필수인 경우에만 그 문제 성립에 필요한 최소 위치만 조작하고 나머지 원문은 그대로 유지하라. 유형별 정확한 문항 수가 지정된 경우 해당 유형명을 type에 그대로 사용하고 각 유형을 지정된 수만큼 정확히 생성한다. 유형별 문항 수의 합계가 총 문항 수이며 임의로 비율을 변경하지 않는다. 선택한 유형을 우선 사용한다.`}
prompt+=`\n\n[이미 출제된 문제 - 재출제 금지]\n${old||'없음'}`;const txt=await aiText(base,prompt);const data=cleanJson(txt);let qs=Array.isArray(data.questions)?data.questions:[];if(!qs.length)throw Error("생성된 문제가 없습니다.");if(b.total&&qs.length>b.total)qs=qs.slice(0,b.total);
// 2차 선지 검수: 생성과 검수를 분리해 뻔한 오답/복수정답/길이 힌트를 한 번 더 제거한다.
const mc=qs.map((q,i)=>({i,type:q.type,prompt:q.prompt,passage:q.passage,options:q.options,answer:q.answer,evidence:q.evidence})).filter(x=>Array.isArray(x.options)&&x.options.length===5);
if(mc.length){try{const qaInput=`다음 객관식 문항을 '선지 설계 → 오답 사유 태깅 → 공정성 검수' 순서로 독립 검수하라. 문제의 평가 목표와 정답 근거는 유지한다. 정답 자체가 근거와 충돌할 때만 정답 번호를 수정한다.

[오답 전략 태그]
PARTIAL=부분 일치, SCOPE=범위 왜곡, CAUSE=인과 왜곡, ROLE=주체/대상 교체, CONDITION=조건 변형, FOCUS=초점 이동, REVERSAL=논리 반전, OVERINFER=과잉 추론, COMMONSENSE=상식 유혹, KEYWORD=키워드 유혹, RELATION=관계 왜곡, NEAR_CONCEPT=근접개념, MIXED_DETAIL=문단/세부 혼합, NEAR_CORRECT=정답 근접형, GRAMMAR_CONFUSION=동일 문법체계 오개념.

[유형별 기준]
- 주제/요지/제목/주장: PARTIAL, FOCUS, SCOPE, OVERINFER, NEAR_CORRECT 중심.
- 내용 일치/불일치/지칭: ROLE, CONDITION, CAUSE, MIXED_DETAIL 중심.
- 빈칸/함의: NEAR_CONCEPT, RELATION, REVERSAL, NEAR_CORRECT 중심.
- 순서/삽입/무관문장/요약: 연결어, 지시어, 논리 전개, 문단 역할을 근거로 설계.
- 어휘: 같은 품사와 의미장 안에서 실제 경쟁 가능한 어휘 사용.
- 어법/문법: 목표 문법 안의 실제 오개념만 사용. 다른 우연한 오류로 답을 노출하지 말 것.

[최종 검수]
1. 각 오답은 제공된 지문/목표 문법으로 틀린 이유를 한 문장으로 설명할 수 있어야 한다.
2. 정답은 정확히 하나여야 하고, 오답 4개는 가능하면 서로 다른 태그를 사용한다.
3. 정답만 길거나 구체적이거나 원문 표현과 과도하게 일치하지 않게 한다.
4. 단순 부정, 절대어, 엉뚱한 소재, 품사 불일치처럼 형태만 보고 제거 가능한 오답은 교체한다.
5. 난이도는 어휘 난삽화가 아니라 정답과 오답의 의미적 근접성으로 조절한다.
6. 정답과 선지 전체의 길이·문체·문장구조를 최대한 평행하게 한다.
7. 모든 선지가 실제 시험지에 바로 들어갈 자연스러운 영어/한국어인지 확인한다.
8. 빈칸 추론은 빈칸이 글의 MAIN CLAIM/핵심 결론/핵심 논리관계에 놓였는지, 단순 세부사항이나 바로 앞 동의어 찾기로 풀리지 않는지 확인한다.
9. 무관문장/삽입/순서는 소재 차이 또는 연결어 하나만으로 답이 드러나지 않고 담화 결속성과 최소 2개 이상의 연결 단서를 실제로 추론해야 하는지 확인한다.
10. 요약은 글 전체 관계를 재구성해야 하며 원문 한 문장 복사로 풀리지 않는지 확인한다. 어법/어휘는 표면 형태만 보고 답이 보이지 않고 실제 문맥·구문 판단이 필요한지 확인한다.
11. 위 핵심 유형에서 이 기준을 만족하지 못하면 quality.typeSpecificStrong=false로 표시한다.

반드시 JSON만 출력:
{"items":[{"i":0,"options":["...","...","...","...","..."],"answer":1,"tags":["CORRECT","PARTIAL","SCOPE","CAUSE","FOCUS"],"reasons":["정답 근거","오답 이유","오답 이유","오답 이유","오답 이유"],"quality":{"singleAnswer":true,"balanced":true,"sourceGrounded":true,"typeSpecificStrong":true}}]}
options/tags/reasons는 각각 정확히 5개이고 같은 인덱스끼리 대응해야 한다. 정답 위치의 tag는 CORRECT로 한다.

문항:
${JSON.stringify(mc).slice(0,70000)}`;
const qa=cleanJson(await aiText("너는 한국 중고등학교 영어시험의 선택지 설계·검수 전문가다. 단순히 헷갈리게 하지 말고, 평가하려는 능력에서 발생하는 실제 오개념을 이용해 변별력 있고 공정한 5지선다를 만든다. 모든 오답은 틀린 이유가 설명 가능해야 한다.",qaInput));
for(const z of (qa.items||[])){const q=qs[Number(z.i)];if(q&&Array.isArray(z.options)&&z.options.length===5){q.options=z.options;if(Number(z.answer)>=1&&Number(z.answer)<=5)q.answer=Number(z.answer);q.choiceMeta={tags:Array.isArray(z.tags)?z.tags:[],reasons:Array.isArray(z.reasons)?z.reasons:[],quality:z.quality||{}}}}
}catch(e){console.error("distractor QA skipped:",e.message)}}
// TYPE QUALITY GATE: 핵심 유형은 별도 QA가 강한 문항으로 판정한 경우만 통과시킨다.
const hardTypeRe=/(빈칸|무관|삽입|순서|요약|어법|어휘)/;
const weakType=qs.map((q,i)=>({q,i})).filter(({q})=>hardTypeRe.test(String(q.type||'')) && Array.isArray(q.options) && q.options.length===5 && q.choiceMeta?.quality?.typeSpecificStrong===false);
if(weakType.length) throw Error(`TYPE QUALITY GATE 위반: ${weakType.map(x=>x.i+1).join(', ')}번 문항이 핵심 추론 없이 풀리거나 정답이 뻔한 것으로 판정되었습니다. 해당 문항을 다시 생성해주세요.`);
// WEEKLY 독립 문법 출제 코드 검증.
if(mode==='weekly'){
 const requestedGrammar=Math.max(0,Number(b.grammarCount)||0);
 const selectedGrammar=Array.isArray(b.grammar)?b.grammar:[];
 const grammarSource=['passage','mixed'].includes(b.grammarSource)?b.grammarSource:'independent';
 if(requestedGrammar>0){
   if(!selectedGrammar.length) throw Error('WEEKLY 문법 출제: 문법 사항을 하나 이상 선택해주세요.');
   if(grammarSource==='passage'&&!String(b.grammarText||'').trim()) throw Error('WEEKLY 문법 출제: 지문 활용 모드는 배운 지문 / 예문이 필요합니다.');
   const gqs=qs.filter(q=>q.sourceKind==='grammar');
   if(gqs.length!==requestedGrammar) throw Error(`WEEKLY 문법 문항 수 위반: 요청 ${requestedGrammar}문항 / 생성 ${gqs.length}문항. 다시 생성해주세요.`);
   if(grammarSource==='independent'){
     const bad=gqs.filter(q=>String(q.sourceExcerpt||'').trim());
     if(bad.length) throw Error('WEEKLY 독립 문법 출제 위반: 독립 생성 문법 문항의 sourceExcerpt는 비어 있어야 합니다.');
   }
 }
}

// 유형별 문항 수 절대 검증: 사용자가 지정한 구성은 AI가 임의 변경할 수 없다.
{
 const counts=mode==='simul'?(b.typeCounts||{}):(b.mockTypeCounts||{});
 const entries=Object.entries(counts).filter(([_,n])=>Number(n)>0);
 if(entries.length){
   const scope=mode==='simul'?qs:qs.filter(q=>q.sourceKind==='mock');
   const violations=[];
   for(const [type,n0] of entries){const n=Number(n0);const actual=scope.filter(q=>String(q.type||'').trim()===String(type).trim()).length;if(actual!==n)violations.push(`${type}: 요청 ${n} / 생성 ${actual}`)}
   if(violations.length) throw Error(`유형별 문항 수 위반: ${violations.join(', ')}. 지정한 문항 구성대로 다시 생성해주세요.`);
 }
}

// WEEKLY 해석 테스트 절대 규칙 코드 검증.
if(mode==='weekly'){
 const requested=Math.max(0,Number(b.translationCount)||0);
 const source=String(b.translationText||'');
 const tqs=qs.filter(q=>q.sourceKind==='translation');
 if(requested>0){
   if(!source.trim()) throw Error('WEEKLY 해석 테스트: 배운 지문 / 예문을 먼저 입력해주세요.');
   if(tqs.length!==requested) throw Error(`WEEKLY 해석 테스트 문항 수 위반: 요청 ${requested}문항 / 생성 ${tqs.length}문항. 다시 생성해주세요.`);
   const norm=x=>String(x||'').replace(/\s+/g,' ').trim();
   const ns=norm(source);
   const seen=new Set();
   const violations=[];
   tqs.forEach((q,i)=>{
     const passage=norm(q.passage), excerpt=norm(q.sourceExcerpt);
     if(!passage || !ns.includes(passage)) violations.push(`${i+1}번 영어 문장이 수업 지문 원문과 불일치`);
     if(!excerpt || passage!==excerpt) violations.push(`${i+1}번 sourceExcerpt 불일치`);
     if(Array.isArray(q.options) && q.options.length) violations.push(`${i+1}번은 서술형이어야 함`);
     if(!String(q.answerText||'').trim()) violations.push(`${i+1}번 모범 해석 없음`);
     if(seen.has(passage)) violations.push(`${i+1}번 중복 문장`); else seen.add(passage);
   });
   if(violations.length) throw Error(`WEEKLY TRANSLATION LOCK 위반: ${violations.join(', ')}. 원문에 실제 존재하는 문장만 사용해야 합니다.`);
 }
}

// WEEKLY 모의고사 이중 모드 절대 규칙 코드 검증.
if(mode==='weekly' && String(b.mockText||'').trim()){
 const raw=String(b.mockText||'');
 const norm=x=>String(x||'').replace(/\s+/g,' ').trim();
 const rawN=norm(raw);
 const sentenceCount=x=>{const t=String(x||'').replace(/\b(?:Mr|Mrs|Ms|Dr|St)\./g,m=>m.slice(0,-1)+'§'); const m=t.match(/[^.!?]+[.!?]+(?:[”’"']+)?/g); return m?m.length:(norm(t)?1:0)};
 const compact=x=>String(x||'').replace(/\s+/g,'').length;
 const transformRe=/(빈칸|어법|어휘|삽입|순서|무관|배열|고쳐쓰기|영작|문장 전환|요약문 완성)/;
 const weeklyMockMode=b.mockMode==='original'?'original':'transform';
 const violations=[];
 qs.forEach((q,i)=>{
   if(String(q.sourceKind||'').toLowerCase()!=='mock') return;
   const ex=String(q.sourceExcerpt||'').trim(), pg=String(q.passage||'').trim();
   if(!ex || !pg){violations.push(`${i+1}(원문구간/지문 누락)`);return;}
   if(!rawN.includes(norm(ex))){violations.push(`${i+1}(sourceExcerpt가 원자료와 불일치)`);return;}
   const es=sentenceCount(ex), ps=sentenceCount(pg);
   if(weeklyMockMode==='original'){
     // 비조작형은 글자 그대로 일치해야 한다. 조작형도 문장수/분량 감소를 금지해 요약을 막는다.
     if(!transformRe.test(String(q.type||'')) && norm(pg)!==norm(ex)) violations.push(`${i+1}(원문 그대로 모드인데 passage 변형)`);
     if(ps<es) violations.push(`${i+1}(원문 그대로 모드 문장수 ${ps}<${es})`);
     const ratio=compact(pg)/Math.max(1,compact(ex));
     if(ratio<0.75) violations.push(`${i+1}(원문 그대로 모드 길이 ${Math.round(ratio*100)}%)`);
   }else{
     if(ps<es) violations.push(`${i+1}(문장수 ${ps}<${es})`);
     if(es>=5 && ps<5) violations.push(`${i+1}(5문장 미만)`);
     const ratio=compact(pg)/Math.max(1,compact(ex));
     if(ratio<0.75) violations.push(`${i+1}(길이 ${Math.round(ratio*100)}%)`);
   }
 });
 if(violations.length) throw Error(`WEEKLY ${weeklyMockMode==='original'?'ORIGINAL LOCK':'LENGTH LOCK'} 위반: ${violations.join(', ')}. 선택한 WEEKLY 지문 모드 규칙을 지키지 않은 문항은 저장하지 않습니다. 다시 생성해주세요.`);
}
// SIMUL 원문 절대 보존 코드 검증: 비변형형 문항의 passage는 시험범위 원문의 연속 구간이어야 한다.
if(mode==='simul'){
 const raw=String(b.rangeText||'');
 const norm=x=>String(x||'').replace(/\s+/g,' ').trim();
 const rawN=norm(raw);
 const transformRe=/(빈칸|어법|어휘|삽입|순서|무관|배열|고쳐쓰기|영작|문장 전환|요약문 완성)/;
 const violations=[];
 qs.forEach((q,i)=>{
   const p=norm(q.passage);
   if(!p)return;
   if(!transformRe.test(String(q.type||'')) && !rawN.includes(p)) violations.push(i+1);
 });
 if(violations.length) throw Error(`SOURCE TEXT LOCK 위반: ${violations.join(', ')}번 문항이 시험범위 원문을 요약/의역/변형했습니다. 시험지를 저장하지 않았습니다. 다시 생성해주세요.`);
}
const source=mode==='weekly'?String(b.grammarText||'')+String(b.translationText||'')+String(b.mockText||''):String(b.rangeText||'');await saveHistory({school,grade:b.grade||'',mode,sourceHash:hash(source)},qs);res.json({mode,title:data.title||(mode==='weekly'?'WEEKLY TEST':'SIMUL TEST'),school,questions:qs})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/history",async(q,s)=>{try{if(pool){const r=await pool.query("select * from exam_history order by created_at desc limit 300");return s.json(r.rows)}s.json(mem.history)}catch(e){s.status(500).json({error:e.message})}});

const R={};
app.post("/api/voca/room",async(req,res)=>{
 let c; do{c=String(Math.floor(100000+Math.random()*900000))}while(R[c]);
 let sets=req.body.sets||[]; R[c]={sets,i:-1,s:{},h:null,timer:null,nextTimer:null,deadline:0,locked:false,className:req.body.className||""};
 let u=req.protocol+"://"+req.get("host")+"/student.html?room="+c;
 res.json({c,u,qr:await QRCode.toDataURL(u,{width:300,margin:1})});
});
app.get("/api/voca/stats",async(q,s)=>{
 try{
  if(pool){let r=await pool.query("select * from vocab_attempts order by created_at desc limit 500");return s.json(r.rows)}
  s.json(mem.vocabAttempts);
 }catch(e){s.status(500).json({error:e.message})}
});
async function saveAttempt(st,r){
 const wrong=st.wrong||[];
 if(pool) await pool.query("insert into vocab_attempts(student,class_name,set_name,total,correct,wrong_words) values($1,$2,$3,$4,$5,$6)",
 [st.n,r.className,st.setName,st.total,st.correct,JSON.stringify(wrong)]);
 else mem.vocabAttempts.unshift({student:st.n,class_name:r.className,set_name:st.setName,total:st.total,correct:st.correct,wrong_words:wrong,created_at:new Date().toISOString()});
}
io.on("connection",s=>{
 s.on("host",c=>{if(!R[c])return;s.join(c);R[c].h=s.id});
 s.on("getSets",c=>{let r=R[c];if(!r)return s.emit("bad");s.emit("sets",r.sets.map(z=>({id:z.id,name:z.name})))});
 s.on("join",x=>{let r=R[x.c];if(!r)return s.emit("bad");let set=r.sets.find(z=>z.id===x.setId);if(!set)return s.emit("badSet");
   r.s[s.id]={n:(x.n||"학생").slice(0,20),setId:set.id,setName:set.name,score:0,correct:0,total:set.q.length,a:false,wrong:[],started:Date.now()};s.join(x.c);s.emit("ok",{setName:set.name});emitLobby(r)});
 function emitLobby(r){if(r.h)io.to(r.h).emit("names",Object.values(r.s))}
 function clear(r){clearTimeout(r.timer);clearTimeout(r.nextTimer);r.timer=r.nextTimer=null}
 function maxLen(r){return Math.max(0,...r.sets.map(z=>z.q.length))}
 function sendQuestion(r){const n=r.i+1;Object.entries(r.s).forEach(([id,st])=>{let set=r.sets.find(z=>z.id===st.setId),q=set?.q[r.i];
   if(q)io.to(id).emit("q",{n,total:set.q.length,t:q.t,o:q.o,deadline:r.deadline,setName:set.name});else st.a=true});
   if(r.h)io.to(r.h).emit("hostRound",{n,total:maxLen(r),deadline:r.deadline});
 }
 function next(c){let r=R[c];if(!r||r.locked)return;r.locked=true;clear(r);r.i++;Object.values(r.s).forEach(st=>st.a=false);
   if(r.i>=maxLen(r)){finish(r);r.locked=false;return}
   r.deadline=Date.now()+10000;sendQuestion(r);
   r.timer=setTimeout(()=>{r.timer=null;io.to(c).emit("timeup");r.nextTimer=setTimeout(()=>next(c),900)},10000);r.locked=false;
 }
 function active(r){return Object.values(r.s).filter(st=>r.sets.find(z=>z.id===st.setId)?.q[r.i])}
 function allDone(r){let a=active(r);return a.length>0&&a.every(st=>st.a)}
 async function finish(r){
   let all=Object.values(r.s).sort((a,b)=>b.correct-a.correct||b.score-a.score||(a.started-b.started));
   for(const st of all){try{await saveAttempt(st,r)}catch(e){console.error(e)}}
   if(r.h)io.to(r.h).emit("endHost",all);
   Object.keys(r.s).forEach(id=>io.to(id).emit("endStudent",{overall:all.slice(0,3)}));
 }
 s.on("start",next);s.on("next",next);
 s.on("ans",x=>{let r=R[x.c],st=r?.s[s.id];if(!st||st.a||Date.now()>r.deadline)return;let set=r.sets.find(z=>z.id===st.setId),q=set?.q[r.i];if(!q)return;
   st.a=true;let good=Number(x.a)===Number(q.a);if(good){st.score+=100;st.correct++}else st.wrong.push({word:q.word||q.t,correct:q.o?.[q.a-1]||q.a});
   s.emit("result",{good,correct:q.a});if(r.h)io.to(r.h).emit("scores",{students:Object.values(r.s),answered:active(r).filter(v=>v.a).length,total:active(r).length});
   if(allDone(r)){clear(r);io.to(x.c).emit("allAnswered");r.nextTimer=setTimeout(()=>next(x.c),1200)}
 });
 s.on("disconnect",()=>{for(const c in R){if(R[c].s[s.id]){delete R[c].s[s.id];emitLobby(R[c])}}});
});
require("./workbook_routes")(app);
srv.listen(process.env.PORT||3000);
