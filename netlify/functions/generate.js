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

    
    // Auto mark MNP checkboxes on PDF when 번호이동
    if (jt === 'port') {
      data.mnp1 = '1';
      data.mnp2 = '1';
      data.mnp3 = '1';
    } else {
      data.mnp1 = '';
      data.mnp2 = '';
      data.mnp3 = '';
    }

    // Split apply date into Y/M/D (for separate coordinate mapping)
    const now = new Date();
    data.apply_date_year = String(now.getFullYear());
    data.apply_date_month = String(now.getMonth() + 1).padStart(2,'0');
    data.apply_date_day = String(now.getDate()).padStart(2,'0');

    
    // Compose printable address (Road + detail)
    const road = String(data.addr_road || '').trim();
    const detail = String(data.addr_detail || '').trim();
    const addrPrint = [road, detail].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    // keep mapping key "addr" for PDF printing
    data.addr = addrPrint;
// Passport info print block (label + value)
    if (String(data.id_doc_type || '') === 'passport') {
      const lines = [];
      if (data.passport_no) lines.push(`-여권번호 : ${data.passport_no}`);
      if (data.nationality) lines.push(`-국적 : ${data.nationality}`);
      if (data.passport_birth) lines.push(`-생년월일 : ${data.passport_birth}`);
      if (data.stay_status) lines.push(`-체류자격 : ${data.stay_status}`);
      if (data.stay_expiry) lines.push(`-체류기간 만료일 : ${data.stay_expiry}`);
      data.passport_info_print = lines.join('\n');
    } else {
      data.passport_info_print = '';
      data.passport_no = '';
      data.nationality = '';
      data.passport_birth = '';
      data.stay_status = '';
      data.stay_expiry = '';
    }



// eSIM info print block (label + value)
// Printed as 4 lines:
// -모델명: ...
// -imei: ...
// -imei2: ...
// -EID: ...
if (String(data.sim_type || '') === 'esim') {
  const model = String(data.esim_model || '').trim();
  const imei1 = String(data.imei1 || '').trim();
  const imei2 = String(data.imei2 || '').trim();
  const eid = String(data.eid || '').trim();

  // If nothing is filled yet, avoid printing a blank block.
  if (model || imei1 || imei2 || eid) {
    data.esim_info_print = [
      `-모델명: ${model}`,
      `-imei: ${imei1}`,
      `-imei2: ${imei2}`,
      `-EID: ${eid}`
    ].join('\n');
  } else {
    data.esim_info_print = '';
  }
} else {
  // When not eSIM, clear eSIM-only fields so they never print.
  data.esim_info_print = '';
  data.esim_model = '';
  data.imei1 = '';
  data.imei2 = '';
  data.eid = '';
}

// Resolve file paths (repo root is 2 levels up from /netlify/functions)
    const root = path.join(__dirname, "..", "..");
    const templatePath = path.join(root, "template.pdf");
    const fontPath = path.join(root, "malgun.ttf");
    const mappingPath = path.join(root, "mappings", "mapping.json");
    const mappingPathFallback = path.join(root, "mapping.json");

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
    if (fs.existsSync(mappingPath)) {
      mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
    } else if (fs.existsSync(mappingPathFallback)) {
      mapping = JSON.parse(fs.readFileSync(mappingPathFallback, "utf8"));
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

        // 이름/예금주 출력은 "짧으면 중앙(두 줄 사이), 길면 첫 줄부터" 규칙 적용
        // - 짧은 이름(줄바꿈 없음)인 경우, 기존 y(첫 줄 기준)보다 아래로 내려서 가운데 정렬 느낌을 만든다.
        // - 줄바꿈이 생기면(긴 이름) 기존대로 첫 줄 위치에 붙는다.
        let yBase = y;
        const needsMidlineForShort = (key === "subscriber_name_print" || key === "autopay_holder_print");
        if(needsMidlineForShort && lines.length === 1){
          // lineHeight의 절반 정도 내려주면 2줄 영역의 가운데에 들어간다.
          yBase = y - (lineHeight * 0.5);
        }

        for(let i=0; i<lines.length; i++){
          const line = lines[i];
          if(!line) continue;
          page.drawText(line, {
            x,
            y: yBase - (i * lineHeight),
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
        "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="SK_foreigner_special_plan.pdf"`,
        "Cache-Control": "no-store"
      },
      body
    };
  }catch(err){
    return { statusCode: 500, body: String((err && err.stack) || err) };
  }
};