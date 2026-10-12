"use strict";

function normalize(text) {
  return String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function blocks(text) {
  return normalize(text).split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
}

function sentences(text, locale) {
  const source = normalize(text).replace(/(^|\n)\s*(?:\*\*)?\d+[.)](?:\*\*)?\s*/g, "$1").replace(/\n+/g, " ");
  const parts = [...new Intl.Segmenter(locale, { granularity: "sentence" }).segment(source)]
    .map(item => item.segment.trim()).filter(Boolean);
  const merged = [];
  for (const part of parts) {
    if (merged.length && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|e\.g|i\.e)\.)$/i.test(merged.at(-1))) merged[merged.length - 1] += " " + part;
    else merged.push(part);
  }
  return merged;
}

function parseSource(title, english, korean = "") {
  const enBlocks = blocks(english), koBlocks = blocks(korean);
  if (!enBlocks.length) throw Error("영어 지문을 입력해 주세요.");
  if (koBlocks.length && enBlocks.length !== koBlocks.length) {
    throw Error(`영어 ${enBlocks.length}문단과 해석 ${koBlocks.length}문단이 일치하지 않습니다.`);
  }
  const paragraphs = enBlocks.map((block, i) => {
    const lines = block.split("\n");
    const heading = /^#\s+/.test(lines[0]) ? lines.shift().replace(/^#\s+/, "").trim() : "";
    const en = sentences(lines.join("\n"), "en");
    if (!en.length) throw Error(`Paragraph ${i + 1}에 문장이 없습니다.`);
    let ko = [];
    if (koBlocks.length) {
      const kLines = koBlocks[i].split("\n");
      if (/^#\s+/.test(kLines[0])) kLines.shift();
      ko = sentences(kLines.join("\n"), "ko");
      if (ko.length !== en.length) {
        throw Error(`Paragraph ${i + 1}: 영어 ${en.length}문장, 해석 ${ko.length}문장입니다. 해석을 문장별로 정리하거나 빈칸으로 두세요.`);
      }
    }
    return { heading, sentences: en.map((sentence, j) => ({ en: sentence, ko: ko[j] || "" })) };
  });
  const total = paragraphs.reduce((n, p) => n + p.sentences.length, 0);
  if (total > 90) throw Error("한 번에 90문장 이하로 나누어 생성해 주세요.");
  return { title: String(title || "").trim() || "English Reading Workbook", paragraphs };
}

function readingRanges(count) {
  if (!Number.isInteger(count) || count < 1) throw Error("문장이 필요합니다.");
  if (count === 1) return [[0, 1]];
  const sizes = count % 2 ? [3] : [];
  for (let left = count - sizes.reduce((a, b) => a + b, 0); left > 0; left -= 2) sizes.push(2);
  let start = 0;
  return sizes.map(size => { const item = [start, start + size]; start += size; return item; });
}

function matchOnce(sentence, value, replacement) {
  if (!value || typeof value !== "string") throw Error("원문의 선택 표현이 비어 있습니다.");
  let at = -1;
  while ((at = sentence.indexOf(value, at + 1)) >= 0) {
    const before = sentence.slice(0, at), after = sentence.slice(at + value.length);
    // Prevent matching the middle of a word (including a contraction).
    if (!/\p{L}$/u.test(before) && !/^\p{L}/u.test(after)) return before + replacement + after;
  }
  throw Error(`원문에서 독립된 표현 ${JSON.stringify(value)}을 찾지 못했습니다.`);
}

function validateParagraph(par, source, number) {
  const label = `Paragraph ${number}`;
  if (!Array.isArray(par.sentences) || par.sentences.length !== source.sentences.length) {
    throw Error(`${label}: 문장 수가 원문과 다릅니다.`);
  }
  for (let i = 0; i < par.sentences.length; i++) {
    const row = par.sentences[i], en = source.sentences[i].en;
    if (row.en !== en || !String(row.ko || "").trim()) throw Error(`${label} 문장 ${i + 1}: 원문 또는 해석을 확인하세요.`);
    if (!Array.isArray(row.blanks) || ![2, 3].includes(row.blanks.length) || new Set(row.blanks).size !== row.blanks.length) {
      throw Error(`${label} 문장 ${i + 1}: 서로 다른 빈칸 단어 2~3개가 필요합니다.`);
    }
    let masked = en;
    for (const word of row.blanks) {
      if (typeof word !== "string" || /\s/.test(word)) throw Error(`${label} 문장 ${i + 1}: 빈칸은 단일 단어여야 합니다.`);
      masked = matchOnce(masked, word, "________");
    }
    if (!row.grammar_correct || !row.grammar_wrong || row.grammar_correct === row.grammar_wrong || !row.grammar_reason) {
      throw Error(`${label} 문장 ${i + 1}: 어법 선택 및 근거를 확인하세요.`);
    }
    matchOnce(en, row.grammar_correct, "____");
    if (i > 0 && !String(row.connection || "").trim()) throw Error(`${label} 문장 ${i + 1}: 앞 문장과의 논리 관계가 빠졌습니다.`);
  }
  if (!par.topic || !par.paragraph_title || !Array.isArray(par.questions) || !par.questions.length || !Array.isArray(par.ox) || !par.ox.length) {
    throw Error(`${label}: 주제·제목·내용 문항을 확인하세요.`);
  }
  for (const q of par.questions) if (!q.question || !q.answer) throw Error(`${label}: 내용 확인 문제에 답이 없습니다.`);
  for (const q of par.ox) if (!q.statement || !["O", "X"].includes(q.answer) || !q.reason) throw Error(`${label}: O/X 문제를 확인하세요.`);
  if (new Set(par.ox.map(q => q.answer)).size !== 2) throw Error(`${label}: O와 X가 모두 필요합니다.`);
}

function maskSentence(row) {
  return row.blanks.reduce((text, word) => matchOnce(text, word, "________"), row.en);
}

function grammarSentence(row) {
  return matchOnce(row.en, row.grammar_correct, `(${row.grammar_correct} / ${row.grammar_wrong})`);
}

function shuffled(length, seed) {
  const order = Array.from({ length }, (_, i) => i);
  let x = (seed || 1) >>> 0;
  for (let i = length - 1; i > 0; i--) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const j = (x >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (length > 1 && order.every((v, i) => v === i)) order.push(order.shift());
  return order;
}

function orderBlocks(paragraphs) {
  if (paragraphs.length > 1) return paragraphs.map((p, i) => ({ index: i, sentences: p.sentences.map(s => s.en) }));
  const rows = paragraphs[0].sentences;
  if (rows.length < 2) return [{ index: 0, sentences: rows.map(s => s.en) }];
  const count = Math.min(3, rows.length);
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    sentences: rows.slice(Math.floor(i * rows.length / count), Math.floor((i + 1) * rows.length / count)).map(s => s.en),
  }));
}

module.exports = { parseSource, readingRanges, matchOnce, validateParagraph, maskSentence, grammarSentence, shuffled, orderBlocks };
