"use strict";
const crypto = require("crypto");
const { parseSource, readingRanges, validateParagraph } = require("./workbook_core");

const jobs = new Map();
const MAX_JOBS = 24;
const textModel = () => process.env.OPENAI_WORKBOOK_MODEL || "gpt-5-mini";
const imageModel = () => process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini";
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: "string" };
const schema = object({
  sentences: { type: "array", items: object({
    translation: str, blanks: { type: "array", items: str },
    grammar_correct: str, grammar_wrong: str, grammar_reason: str, connection: str,
  }) },
  topic: str, paragraph_title: str,
  questions: { type: "array", items: object({ question: str, answer: str }) },
  ox: { type: "array", items: object({ statement: str, answer: { type: "string", enum: ["O", "X"] }, reason: str }) },
});

async function openai(path, body, timeout) {
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  let data;
  try { data = await r.json(); } catch { throw Error(`OpenAI 응답을 읽지 못했습니다 (${r.status}).`); }
  if (!r.ok) throw Error(`OpenAI 오류 (${r.status}): ${data.error?.message || "요청 실패"}`);
  return data;
}

async function generateParagraph(source, i, previous, feedback = "") {
  const target = Math.min(5, Math.max(4, source.sentences.length));
  const instruction = `You are a Korean high-school English workbook editor. Reply with the given strict JSON schema.
Use exactly one sentence object for every source sentence and preserve their order. Do not rewrite or omit any English sentence.
Provide natural Korean translation for each sentence; when provided, reproduce its Korean translation verbatim.
For EVERY English sentence choose 2 or 3 DIFFERENT, single-word blanks copied EXACTLY with case from the sentence. No phrase blanks.
For EVERY English sentence choose a grammatically meaningful correct expression copied EXACTLY from its source and a clearly wrong alternative. Explain the choice in Korean. Avoid stylistic or ambiguous choices.
Connection: briefly explain in Korean WHY the immediately preceding sentence leads to this one, citing the actual logical move. For paragraph 1 sentence 1 use empty string; when prior-paragraph context is provided, explain the cross-paragraph connection for its first sentence.
Write ${target} Korean content questions, from overall idea to concrete details, with answers. Write ${target} fairly tricky Korean O/X statements including at least one O and one X; keep distinctions factual and give the reason/correction. Provide Korean topic and paragraph title. No invented source facts.${feedback ? ` Prior validation error: ${feedback.slice(0, 700)}` : ""}`;
  const response = await openai("responses", {
    model: textModel(), store: false, reasoning: { effort: "low" },
    input: [
      { role: "developer", content: instruction },
      { role: "user", content: JSON.stringify({ paragraph: i + 1, previous_sentence: previous, ...source }) },
    ],
    text: { format: { type: "json_schema", name: "workbook_paragraph", strict: true, schema } },
    max_output_tokens: Math.min(14000, Math.max(4000, source.sentences.length * 850 + 1400)),
  }, 240000);
  if (response.status !== "completed") throw Error(`모델 응답 미완료: ${response.status || "unknown"}`);
  const output = response.output?.flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("");
  if (!output) throw Error("워크북 응답이 비었습니다.");
  const generated = JSON.parse(output);
  if (generated.sentences.length !== source.sentences.length) throw Error("문장 수가 원문과 다릅니다.");
  if (generated.questions.length !== target || generated.ox.length !== target) throw Error("내용 확인 문항 수가 맞지 않습니다.");
  const par = {
    heading: source.heading, topic: generated.topic, paragraph_title: generated.paragraph_title,
    questions: generated.questions, ox: generated.ox,
    sentences: source.sentences.map((row, j) => ({
      en: row.en, ko: row.ko || generated.sentences[j].translation,
      blanks: generated.sentences[j].blanks,
      grammar_correct: generated.sentences[j].grammar_correct,
      grammar_wrong: generated.sentences[j].grammar_wrong,
      grammar_reason: generated.sentences[j].grammar_reason,
      connection: generated.sentences[j].connection,
    })),
  };
  validateParagraph(par, source, i + 1);
  return par;
}

async function parallel(items, limit, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = cursor++;
      await worker(items[current], current);
    }
  }));
}

async function generateImage(job, item) {
  const prompt = `One polished 2D animation-style cartoon for a Korean high-school English READING workbook. Friendly simplified characters, expressive but not realistic, soft colors and clean picture-book line art. Illustrate the exact events or concepts in the following ${item.sentences.length} reading sentences in one coherent scene or two or three visual panels. No text, lettering, numbers, captions, speech bubbles, or logos. Consistent classroom-friendly style. Sentences: ${item.sentences.join(" ")}`;
  const response = await openai("images/generations", {
    model: imageModel(), prompt, size: "1024x1024", quality: "low", output_format: "png", n: 1,
  }, 300000);
  const encoded = response.data?.[0]?.b64_json;
  if (!encoded) throw Error("삽화 응답에 이미지가 없습니다.");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw Error("PNG 형식을 확인할 수 없습니다.");
  job.images.set(item.key, buffer);
  job.imagesDone++;
}

function imageGroups(draft) {
  const groups = [];
  draft.paragraphs.forEach((par, p) => readingRanges(par.sentences.length).forEach(([start, end], g) => {
    groups.push({ key: `p${p + 1}g${g + 1}`, sentences: par.sentences.slice(start, end).map(s => s.en) });
  }));
  return groups;
}

function imageGroupsForParagraph(par, p) {
  return readingRanges(par.sentences.length).map(([start, end], g) => ({
    key: `p${p + 1}g${g + 1}`,
    sentences: par.sentences.slice(start, end).map(s => s.en),
  }));
}

function limiter(limit) {
  let active = 0;
  const waiting = [];
  return task => new Promise((resolve, reject) => {
    const begin = () => {
      active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active--;
        waiting.shift()?.();
      });
    };
    if (active < limit) begin(); else waiting.push(begin);
  });
}

async function runImages(job, groups) {
  job.phase = "images";
  job.imageErrors = [];
  await parallel(groups, 4, async item => {
    try { await generateImage(job, item); }
    catch (e) { job.imageErrors.push(`${item.key}: ${e.message}`); }
  });
  job.phase = job.imageErrors.length ? "partial" : "complete";
  job.updated = Date.now();
}

async function runJob(job) {
  try {
    const source = job.source, results = new Array(source.paragraphs.length);
    const items = source.paragraphs.map((p, i) => ({ p, i }));
    const scheduleImage = limiter(4), imagePromises = [];
    job.imagesTotal = source.paragraphs.reduce((total, par) => total + readingRanges(par.sentences.length).length, 0);
    await parallel(items, 3, async ({ p, i }) => {
      const previous = i ? source.paragraphs[i - 1].sentences.at(-1).en : "";
      let error;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { results[i] = await generateParagraph(p, i, previous, error?.message); break; }
        catch (e) { error = e; if (attempt) throw Error(`Paragraph ${i + 1}: ${e.message}`); }
      }
      job.textDone++;
      // Begin each illustration as soon as its paragraph is ready.
      for (const item of imageGroupsForParagraph(results[i], i)) {
        imagePromises.push(scheduleImage(() => generateImage(job, item))
          .catch(e => { job.imageErrors.push(`${item.key}: ${e.message}`); }));
      }
    });
    job.draft = { title: source.title, paragraphs: results };
    // A valid printable text workbook is available while images are still arriving.
    job.phase = "images";
    await Promise.all(imagePromises);
    job.phase = job.imageErrors.length ? "partial" : "complete";
  } catch (e) {
    job.phase = "failed";
    job.error = e.message || String(e);
  }
  job.updated = Date.now();
}

module.exports = app => {
  app.post("/api/workbook/jobs", (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) throw Error("Render 환경변수에 OPENAI_API_KEY를 설정해 주세요.");
      const body = req.body || {};
      const source = parseSource(body.title, body.english, body.korean);
      if (jobs.size >= MAX_JOBS) {
        for (const [id, job] of jobs) if (job.phase !== "text" && job.phase !== "images" && Date.now() - job.updated > 30 * 60000) jobs.delete(id);
        if (jobs.size >= MAX_JOBS) throw Error("작업이 많습니다. 잠시 후 다시 시도해 주세요.");
      }
      const id = crypto.randomUUID();
      const job = { id, source, phase: "text", textDone: 0, imagesDone: 0, imagesTotal: 0,
        draft: null, images: new Map(), imageErrors: [], error: "", updated: Date.now() };
      jobs.set(id, job);
      res.json({ id, paragraphs: source.paragraphs.length, sentences: source.paragraphs.reduce((n, p) => n + p.sentences.length, 0) });
      void runJob(job);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/workbook/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "작업을 찾을 수 없습니다. 새로 생성해 주세요." });
    res.json({ id: job.id, phase: job.phase, textDone: job.textDone,
      textTotal: job.source.paragraphs.length, imagesDone: job.imagesDone,
      imagesTotal: job.imagesTotal, imageKeys: [...job.images.keys()],
      imageErrors: job.imageErrors, error: job.error, draft: job.draft });
  });

  app.get("/api/workbook/jobs/:id/images/:key", (req, res) => {
    const buffer = jobs.get(req.params.id)?.images.get(req.params.key);
    if (!buffer) return res.sendStatus(404);
    res.type("png").set("Cache-Control", "private, max-age=3600").send(buffer);
  });

  app.post("/api/workbook/jobs/:id/retry-images", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.phase !== "partial") return res.status(400).json({ error: "재시도할 삽화 작업이 없습니다." });
    const remaining = imageGroups(job.draft).filter(item => !job.images.has(item.key));
    res.json({ remaining: remaining.length });
    void runImages(job, remaining);
  });
};

module.exports._test = { parallel, generateParagraph, runJob };
