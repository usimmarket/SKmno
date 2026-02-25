const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

function b64urlDecode(str){
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

function getValueFromSource(data, source, fallbackKey){
  if(Array.isArray(source) && source.length){
    return source.map(s => (data[s] ?? "")).join("");
  }
  if(typeof source === "string" && source){
    return data[source] ?? "";
  }
  return data[fallbackKey] ?? "";
}

function firstExisting(paths){
  for(const p of paths){
    try{
      if(p && fs.existsSync(p)) return p;
    }catch(e){}
  }
  return null;
}

exports.handler = async (event) => {
  try{
    const method = event.httpMethod || "GET";
    let payload = { data: {} };

    if(method === "POST"){
      payload = JSON.parse(event.body || "{}") || { data: {} };
    }else if(method === "GET"){
      const qs = event.queryStringParameters || {};
      if(qs.d){
        payload.data = JSON.parse(b64urlDecode(qs.d));
      }else{
        payload.data = {};
      }
      payload.action = qs.download === "1" ? "download" : "print";
    }else{
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const dataRaw = payload.data || {};
    const data = { ...dataRaw };

    // When 가입유형 is 신규, exclude 번호이동 전용 값들이 PDF에 찍히지 않도록 무조건 제거
    const jt = String(data.join_type || '').toLowerCase();
    if (jt !== 'port') {
      data.prev_carrier = '';
      data.mnp_pay_type = '';
      data.port_number = '';
      data.mvno_name = '';
    }

    // Netlify Functions run in a separate bundle. Static site files are NOT automatically available
    // unless added via netlify.toml functions.included_files.
    // So we resolve paths defensively across likely locations.
    const cwd = process.cwd();
    const taskRoot = process.env.LAMBDA_TASK_ROOT || "";
    const bundleRoot = path.join(__dirname, "..", ".."); // when kept under netlify/functions
    const candidates = [cwd, taskRoot, bundleRoot, __dirname];

    const templatePath = firstExisting(candidates.map(base => base ? path.join(base, "template.pdf") : null));
    if(!templatePath){
      return { statusCode: 500, body: "template.pdf not found. Ensure it's in repo root AND included via netlify.toml [functions].included_files." };
    }

    const mappingPath = firstExisting([
      ...candidates.map(base => base ? path.join(base, "mapping.json") : null),
      ...candidates.map(base => base ? path.join(base, "mappings", "mapping.json") : null),
    ]);

    const fontPath = firstExisting([
      ...candidates.map(base => base ? path.join(base, "malgun.ttf") : null),
    ]);

    const templateBytes = fs.readFileSync(templatePath);
    const pdfDoc = await PDFDocument.load(templateBytes);

    // Embed font (for KR/VN/TH/KH names etc.)
    let font = undefined;
    if(fontPath){
      pdfDoc.registerFontkit(fontkit);
      const fontBytes = fs.readFileSync(fontPath);
      font = await pdfDoc.embedFont(fontBytes, { subset: true });
    }

    let mapping = { fields: {} };
    if(mappingPath){
      mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
    }

    const pages = pdfDoc.getPages();
    const fields = (mapping && mapping.fields) ? mapping.fields : {};

    const checkMark = "V";

    for(const [key, cfg] of Object.entries(fields)){
      const pageIndex = (cfg.page || 1) - 1;
      if(pageIndex < 0 || pageIndex >= pages.length) continue;
      const page = pages[pageIndex];

      const x = Number(cfg.x || 0);
      const y = Number(cfg.y || 0);
      const size = Number(cfg.size || 10);
      const type = (cfg.type || "text").toLowerCase();

      if(type === "text"){
        let value = getValueFromSource(data, cfg.source, key);
        if(value === null || value === undefined) value = "";
        value = String(value);
        if(!value.trim()) continue;

        const lines = value.split(/\r?\n/);
        const lineHeight = size * 1.2;

        for(let i=0; i<lines.length; i++){
          const line = lines[i];
          if(!line) continue;
          page.drawText(line, {
            x,
            y: y - (i * lineHeight),
            size,
            font
          });
        }
      }else if(type === "checkbox"){
        let cur = getValueFromSource(data, cfg.source, key);
        if(cur === null || cur === undefined) cur = "";
        cur = String(cur);

        const onv = cfg.on_value;
        const checked = (
          cur === "1" || cur.toLowerCase() === "true" || cur.toLowerCase() === "yes" ||
          (onv !== undefined && String(onv) === cur)
        );
        if(!checked) continue;

        page.drawText(checkMark, { x, y, size, font });
      }
    }

    const outBytes = await pdfDoc.save();
    const outB64 = Buffer.from(outBytes).toString("base64");

    const isDownload = String(payload.action || "").toLowerCase() === "download";
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": (isDownload ? 'attachment; filename="output.pdf"' : 'inline; filename="output.pdf"'),
        "Cache-Control": "no-store",
      },
      body: outB64,
      isBase64Encoded: true
    };
  }catch(err){
    return { statusCode: 500, body: "PDF generation failed: " + (err && err.stack ? err.stack : String(err)) };
  }
};
