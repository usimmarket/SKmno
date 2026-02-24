const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

function b64urlDecode(str){
  // base64url -> base64
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

function getValueFromSource(data, source, fallbackKey){
  if(Array.isArray(source) && source.length){
    // concatenate sources (common for split fields)
    return source.map(s => (data[s] ?? "")).join("");
  }
  if(typeof source === "string" && source){
    return data[source] ?? "";
  }
  return data[fallbackKey] ?? "";
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

    // Guard: when 가입유형 is 신규, exclude 번호이동 전용 값들이 PDF에 찍히지 않도록 무조건 제거
    const jt = String(data.join_type || '').toLowerCase();
    if (jt !== 'port') {
      data.prev_carrier = '';
      data.mnp_pay_type = '';
      data.port_number = '';
      data.mvno_name = '';
    }

    // Resolve file paths (repo root is 2 levels up from /netlify/functions)
    const root = path.join(__dirname, "..", "..");
    const templatePath = path.join(root, "template.pdf");
    const fontPath = path.join(root, "malgun.ttf");
    const mappingPath = path.join(root, "mappings", "mapping.json");

    if(!fs.existsSync(templatePath)){
      return { statusCode: 500, body: "template.pdf not found in site root." };
    }

    const templateBytes = fs.readFileSync(templatePath);
    const pdfDoc = await PDFDocument.load(templateBytes);

    // Embed font (for KR/VN/TH/KH names etc.)
    if(fs.existsSync(fontPath)){
      pdfDoc.registerFontkit(fontkit);
      const fontBytes = fs.readFileSync(fontPath);
      var font = await pdfDoc.embedFont(fontBytes, { subset: true });
    }

    let mapping = { fields: {} };
    if(fs.existsSync(mappingPath)){
      mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
    }

    const pages = pdfDoc.getPages();
    const fields = (mapping && mapping.fields) ? mapping.fields : {};

    // Use plain 'V' instead of a special checkmark glyph.
    // Some fonts (or font subsetting) don't contain the checkmark glyph and it can render as '&&' or tofu.
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
        const checked = (onv !== undefined)
          ? (cur === String(onv))
          : (cur && cur !== "0" && cur !== "false" && cur !== "off");

        if(!checked) continue;

        page.drawText(checkMark, {
          x,
          y,
          size: size + 2,
          font
        });
      }
    }

    const outBytes = await pdfDoc.save();
    const body = Buffer.from(outBytes).toString("base64");
    const isDownload = payload.action === "download";

    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="freeT_application.pdf"`,
        "Cache-Control": "no-store"
      },
      body
    };
  }catch(err){
    return { statusCode: 500, body: String((err && err.stack) || err) };
  }
};