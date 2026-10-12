"use strict";
let workbookJob = "", workbookDraft = null, workbookPhase = "", workbookImages = new Set();
let workbookStudentPages = 0, workbookTeacherPages = 0;
const wb = id => document.getElementById(id);
const wbEsc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wbChunks = (items, count) => Array.from({ length: Math.ceil(items.length / count) }, (_, i) => items.slice(i * count, (i + 1) * count));
const wbLetter = i => i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
const wbLine = (n = 1) => '<div class="wbBlankLine"></div>'.repeat(n);

function wbRanges(count) {
  if (count === 1) return [[0, 1]];
  const sizes = count % 2 ? [3] : [];
  for (let left = count - sizes.reduce((a, b) => a + b, 0); left > 0; left -= 2) sizes.push(2);
  let start = 0;
  return sizes.map(size => { const result = [start, start + size]; start += size; return result; });
}

function wbShuffle(length, seed) {
  const a = Array.from({ length }, (_, i) => i);
  let x = seed >>> 0 || 1;
  for (let i = length - 1; i > 0; i--) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const j = (x >>> 0) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (length > 1 && a.every((v, i) => v === i)) a.push(a.shift());
  return a;
}

function wbOrderBlocks(pars) {
  if (pars.length > 1) return pars.map((p, i) => ({ index: i, sentences: p.sentences.map(s => s.en) }));
  const rows = pars[0].sentences;
  if (rows.length < 2) return [{ index: 0, sentences: rows.map(s => s.en) }];
  const count = Math.min(3, rows.length);
  return Array.from({ length: count }, (_, i) => ({ index: i,
    sentences: rows.slice(Math.floor(i * rows.length / count), Math.floor((i + 1) * rows.length / count)).map(s => s.en) }));
}

function wbReplaceOnce(text, target, replacement) {
  let at = -1;
  while ((at = text.indexOf(target, at + 1)) >= 0) {
    const before = text.slice(0, at), after = text.slice(at + target.length);
    if (!/\p{L}$/u.test(before) && !/^\p{L}/u.test(after)) return before + replacement + after;
  }
  return text;
}
function wbMask(row) {
  let en = row.en;
  for (const word of row.blanks) en = wbReplaceOnce(en, word, "________");
  return en;
}
function wbGrammar(row) { return wbReplaceOnce(row.en, row.grammar_correct, `(${row.grammar_correct} / ${row.grammar_wrong})`); }
function wbPage(content, section, title, kind = "wbStudent") {
  const number = kind === "wbTeacher" ? ++workbookTeacherPages : ++workbookStudentPages;
  return `<section class="wbPage ${kind}"><div class="wbPageHead"><img src="/jongrom-logo.png" alt=""><span>종로M ENGLISH · ${wbEsc(section)}</span><small>${wbEsc(workbookDraft.title)}</small></div><div class="wbSection">${wbEsc(section)}</div><div class="wbSub">${wbEsc(title)}</div>${content}<div class="wbFooter"><span>전체 문장 워크북</span><span>${number}</span></div></section>`;
}

function wbStudent(draft) {
  let html = "", global = 0;
  const pars = draft.paragraphs;
  pars.forEach((par, p) => {
    const rows = par.sentences, heading = par.heading || par.paragraph_title;
    wbRanges(rows.length).forEach(([start, end], group) => {
      const key = `p${p + 1}g${group + 1}`;
      let content = `<div class="wbImageBox"><span data-wb-placeholder="${key}">해당 문장 삽화 생성 중</span><img class="wbIllustration hidden" data-wb-image="${key}" alt="Paragraph ${p + 1} 문장 ${start + 1}–${end} 삽화"></div>`;
      content += rows.slice(start, end).map((row, j) => `<div class="wbReadingRow"><p class="wbEn"><span class="wbNumber">${global + start + j + 1}.</span>${wbEsc(row.en)}</p><p class="wbKo">${wbEsc(row.ko)}</p></div>`).join("");
      if (end === rows.length) content += `<div class="wbReadingTopics"><div class="wbField">주제${wbLine(2)}</div><div class="wbField">제목${wbLine(2)}</div></div>`;
      html += wbPage(content, "READING", `Paragraph ${p + 1} · ${heading}`, "wbStudent");
    });
    global += rows.length;
  });
  global = 0;
  pars.forEach((par, p) => {
    const rows = par.sentences;
    wbChunks(rows.map((row, i) => ({ row, i })), 3).forEach((group, j) => {
      const content = group.map(({ row, i }) => `<div class="wbItem"><p class="wbEn"><span class="wbNumber">${global + i + 1}.</span>${wbEsc(row.en)}</p><p class="wbPrompt">우리말 해석</p>${wbLine(2)}${(i > 0 || p > 0) ? `<p class="wbPrompt">${i ? `문장 ${global + i} → ${global + i + 1}` : `이전 문단 → 문장 ${global + 1}`} 논리 관계</p>${wbLine(1)}` : ""}</div>`).join("");
      html += wbPage(content, "STEP 1 · 해석 / 문장 사이의 논리 관계 파악", `Paragraph ${p + 1} · 문장 ${j * 3 + 1}–${j * 3 + group.length}`);
    });
    const qHtml = par.questions.map((q, i) => `<div class="wbTask"><p class="wbQuestion">${i + 1}. ${wbEsc(q.question)}</p>${wbLine(2)}</div>`).join("");
    const oxHtml = par.ox.map((q, i) => `<div class="wbTask"><p class="wbQuestion">${i + 1}. ( O / X ) ${wbEsc(q.statement)}</p></div>`).join("");
    html += wbPage(`<h3>내용확인</h3>${qHtml}<h3>내용확인 O/X</h3>${oxHtml}`, "STEP 1 · 내용확인", `Paragraph ${p + 1}`);
    global += rows.length;
  });
  global = 0;
  pars.forEach((par, p) => {
    wbChunks(par.sentences.map((row, i) => ({ row, i })), 5).forEach((group, j) => {
      const content = group.map(({ row, i }) => `<div class="wbItem"><p class="wbEn"><span class="wbNumber">${global + i + 1}.</span>${wbEsc(wbMask(row))}</p><p class="wbSmall">한 문장에 빈칸 2~3개 · 원문대로 완성하기</p>${wbLine(1)}</div>`).join("");
      html += wbPage(content, "STEP 2 · 핵심표현 빈칸", `Paragraph ${p + 1} · ${j + 1}쪽`);
    });
    global += par.sentences.length;
  });
  global = 0;
  pars.forEach((par, p) => {
    wbChunks(par.sentences.map((row, i) => ({ row, i })), 3).forEach((group, j) => {
      const content = group.map(({ row, i }) => `<div class="wbItem"><p class="wbEn"><span class="wbNumber">${global + i + 1}.</span>${wbEsc(wbGrammar(row))}</p><p class="wbPrompt">선택한 어법의 근거</p>${wbLine(2)}</div>`).join("");
      html += wbPage(content, "STEP 3 · 어법 선택", `Paragraph ${p + 1} · ${j + 1}쪽`);
    });
    global += par.sentences.length;
  });
  const blocks = wbOrderBlocks(pars), order = wbShuffle(blocks.length, 74051);
  wbChunks(order.map((original, i) => ({ original, i })), 1).forEach((group, g, all) => {
    let content = group.map(({ original, i }) => `<div class="wbOrderBlock"><b>(${wbLetter(i)})</b> ${blocks[original].sentences.map(wbEsc).join(" ")}</div>`).join("");
    if (g === all.length - 1) content += `<div class="wbAnswerBox">올바른 문단 순서: ${wbLine(1)}</div>`;
    html += wbPage(content, "STEP 4 · 문단 나열", `전체 본문 · ${g + 1}쪽`);
  });
  pars.forEach((par, p) => {
    const order = wbShuffle(par.sentences.length, 91001 + p);
    wbChunks(order.map((original, i) => ({ original, i })), 4).forEach((group, g, all) => {
      let content = group.map(({ original, i }) => `<div class="wbOrderBlock"><b>(${wbLetter(i)})</b> ${wbEsc(par.sentences[original].en)}</div>`).join("");
      if (g === all.length - 1) content += `<div class="wbAnswerBox">올바른 문장 순서: ${wbLine(1)}</div>`;
      html += wbPage(content, "STEP 5 · 문장 나열", `Paragraph ${p + 1} · ${g + 1}쪽`);
    });
  });
  return html;
}

function wbTeacher(draft) {
  let html = "", global = 0;
  draft.paragraphs.forEach((par, p) => {
    wbChunks(par.sentences.map((row, i) => ({ row, i })), 3).forEach((group, j) => {
      const content = group.map(({ row, i }) => `<div class="wbKey"><b>${global + i + 1}. ${wbEsc(row.en)}</b><br>해석: ${wbEsc(row.ko)}<br>STEP 2: ${wbEsc(row.blanks.join(" / "))}<br>STEP 3: ${wbEsc(row.grammar_correct)} / ${wbEsc(row.grammar_wrong)} — ${wbEsc(row.grammar_reason)}${(i > 0 || p > 0) ? `<br>문장 연결: ${wbEsc(row.connection)}` : ""}</div>`).join("");
      html += wbPage(content, "교사용 · 문장별 정답", `Paragraph ${p + 1} · 문장 ${j * 3 + 1}–${j * 3 + group.length}`, "wbTeacher");
    });
    const content = `<div class="wbKey"><b>주제</b> ${wbEsc(par.topic)}<br><b>제목</b> ${wbEsc(par.paragraph_title)}</div>` +
      par.questions.map((q, i) => `<div class="wbKey"><b>내용확인 ${i + 1}.</b> ${wbEsc(q.question)}<br>정답: ${wbEsc(q.answer)}</div>`).join("") +
      par.ox.map((q, i) => `<div class="wbKey"><b>O/X ${i + 1}. ${q.answer}</b> ${wbEsc(q.statement)}<br>근거: ${wbEsc(q.reason)}</div>`).join("");
    html += wbPage(content, "교사용 · 내용확인", `Paragraph ${p + 1}`, "wbTeacher");
    global += par.sentences.length;
  });
  const blocks = wbOrderBlocks(draft.paragraphs), order = wbShuffle(blocks.length, 74051);
  let content = `<div class="wbKey"><b>STEP 4 · 문단 나열</b><br>${blocks.map((_, original) => wbLetter(order.indexOf(original))).join(" → ")}</div>`;
  draft.paragraphs.forEach((par, p) => {
    const seq = wbShuffle(par.sentences.length, 91001 + p);
    content += `<div class="wbKey"><b>STEP 5 · Paragraph ${p + 1} 문장 나열</b><br>${par.sentences.map((_, original) => wbLetter(seq.indexOf(original))).join(" → ")}</div>`;
  });
  html += wbPage(content, "교사용 · 나열 정답", "STEP 4 · STEP 5", "wbTeacher");
  return html;
}

function showWorkbook(draft) {
  workbookDraft = draft;
  workbookStudentPages = workbookTeacherPages = 0;
  document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
  document.querySelector(".tabs").style.display = "none";
  wb("output").classList.remove("hidden");
  wb("ordinaryPrint").classList.add("hidden");
  wb("workbookPrint").classList.remove("hidden");
  wb("paper").innerHTML = wbStudent(draft) + wbTeacher(draft);
  wb("outputMeta").textContent = "본문 분석 완료 · 삽화 생성 중";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateWorkbookImages(keys) {
  keys.forEach(key => {
    if (workbookImages.has(key)) return;
    workbookImages.add(key);
    document.querySelectorAll(`[data-wb-image="${key}"]`).forEach(img => {
      img.src = `/api/workbook/jobs/${encodeURIComponent(workbookJob)}/images/${key}`;
      img.classList.remove("hidden");
    });
    document.querySelectorAll(`[data-wb-placeholder="${key}"]`).forEach(x => x.remove());
  });
}

async function workbookPoll() {
  if (!workbookJob) return;
  try {
    const r = await fetch(`/api/workbook/jobs/${encodeURIComponent(workbookJob)}`);
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    workbookPhase = data.phase;
    if (!workbookDraft && data.draft) showWorkbook(data.draft);
    if (workbookDraft) updateWorkbookImages(data.imageKeys || []);
    const working = data.phase === "text" || data.phase === "images";
    wb("wbProgressTitle").textContent = data.phase === "text" ? "문단 분석 중" : "READING 삽화 생성 중";
    wb("wbProgressText").textContent = data.phase === "text" ? `${data.textDone}/${data.textTotal}문단 분석` : `${data.imagesDone}/${data.imagesTotal}장 완성`;
    wb("wbProgressFill").style.width = `${data.phase === "text" ? Math.round(data.textDone / data.textTotal * 100) : data.imagesTotal ? Math.round(data.imagesDone / data.imagesTotal * 100) : 0}%`;
    if (workbookDraft) {
      wb("outputMeta").textContent = working ? `본문 완성 · 삽화 ${data.imagesDone}/${data.imagesTotal}장 생성 중` :
        data.phase === "complete" ? `완료 · 모든 문장 · 삽화 ${data.imagesDone}장` :
          `삽화 ${data.imagesDone}/${data.imagesTotal}장 · 실패 ${data.imageErrors.length}장 (다시 시도 가능)`;
      wb("workbookPrint").querySelectorAll("button").forEach(b => { if (b.textContent.includes("PDF")) b.disabled = working; });
      wb("wbRetryOutput").classList.toggle("hidden", data.phase !== "partial");
    }
    if (data.phase === "failed") throw Error(data.error);
    if (working) setTimeout(workbookPoll, 1800);
    else {
      wb("wbStart").disabled = false;
      if (data.phase === "partial") {
        wb("wbProgressText").textContent = `삽화 ${data.imageErrors.length}장이 누락되었습니다: ${data.imageErrors.join("; ").slice(0, 400)}`;
        wb("wbRetry").classList.remove("hidden");
      } else wb("wbProgressText").textContent = "워크북이 완성되었습니다. 학생용과 교사용을 각각 인쇄해 PDF로 저장하세요.";
    }
  } catch (e) {
    wb("wbProgressTitle").textContent = "생성 오류";
    wb("wbProgressText").textContent = e.message;
    wb("wbStart").disabled = false;
    if (!workbookDraft && workbookPhase !== "failed") setTimeout(workbookPoll, 3500);
  }
}

async function startWorkbook() {
  if (!wb("wbEnglish").value.trim()) return alert("영어 본문을 입력해 주세요.");
  wb("wbStart").disabled = true;
  wb("wbProgressCard").classList.remove("hidden");
  wb("wbRetry").classList.add("hidden");
  wb("wbProgressTitle").textContent = "생성 시작 중";
  wb("wbProgressText").textContent = "본문을 문장별로 나누고 있습니다.";
  workbookDraft = null; workbookImages = new Set();
  try {
    const r = await fetch("/api/workbook/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      title: wb("wbTitle").value, english: wb("wbEnglish").value, korean: wb("wbKorean").value,
    }) });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    workbookJob = data.id;
    workbookPoll();
  } catch (e) {
    wb("wbStart").disabled = false;
    wb("wbProgressTitle").textContent = "입력을 확인하세요";
    wb("wbProgressText").textContent = e.message;
  }
}

async function retryWorkbookImages() {
  wb("wbRetry").classList.add("hidden");
  wb("wbRetryOutput").classList.add("hidden");
  const r = await fetch(`/api/workbook/jobs/${encodeURIComponent(workbookJob)}/retry-images`, { method: "POST" });
  const data = await r.json();
  if (!r.ok) return alert(data.error);
  workbookPoll();
}

async function printWorkbook(kind) {
  if (!workbookDraft) return;
  if (workbookPhase === "text" || workbookPhase === "images") return alert("삽화 생성이 끝난 뒤 저장해 주세요.");
  await Promise.all([...document.querySelectorAll(".wbIllustration:not(.hidden)")].map(img => img.decode().catch(() => {})));
  window.addEventListener("afterprint", () => document.body.classList.remove(`workbook-print-${kind}`), { once: true });
  document.body.classList.add(`workbook-print-${kind}`);
  window.print();
  setTimeout(() => document.body.classList.remove(`workbook-print-${kind}`), 5000);
}

function downloadWorkbookDraft() {
  if (!workbookDraft) return;
  const blob = new Blob([JSON.stringify(workbookDraft, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = "워크북_검토용_초안.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
