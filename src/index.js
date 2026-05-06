/**
 * PROJECT: TG-TO-BALE RELAY (DEBUG-PRO VERSION)
 * 4 ENV VARS: TG_TOKEN, BALE_TOKEN, BALE_CHAT_ID, ALLOWED_USER_ID
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    try {
      const update = await request.json();
      if (!update.message) return new Response("OK");

      const msg = update.message;

      // 1. امنیت: چک کردن آیدی کاربر
      if (String(msg.from.id) !== String(env.ALLOWED_USER_ID)) {
        console.error(`Unauthorized access attempt from: ${msg.from.id}`);
        return new Response("Unauthorized", { status: 403 });
      }

      let rawText = msg.text || msg.caption || "";
      if (!rawText.trim()) rawText = "📎 محتوای بدون متن";

      const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);
      const file = getFileData(msg);

      // اطلاع‌رسانی اولیه به تلگرام
      const status = await sendTg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: "🔄 شروع پردازش... لطفاً صبور باشید.",
        reply_to_message_id: msg.message_id
      });
      const statusData = await status.json();
      const statusId = statusData.result?.message_id;

      try {
        if (!file && urlMatch) {
          // سناریو لینک خارجی
          await handleLinkDownload(urlMatch[0], rawText, env, msg, statusId);
        } else if (file) {
          // سناریو فایل تلگرامی
          await handleFileTransfer(file, rawText, env, msg, statusId);
        } else {
          // فقط متن
          await sendToBale(env, "sendMessage", { text: cleanText(rawText) });
        }

        if (statusId) await editTg(env, msg.chat.id, statusId, "✅ عملیات با موفقیت انجام شد.");
      } catch (err) {
        // گزارش دقیق خطا به کاربر در تلگرام
        const errorMsg = `❌ خطا در مرحله: ${err.message}`;
        if (statusId) await editTg(env, msg.chat.id, statusId, errorMsg);
        console.error(errorMsg);
      }

    } catch (err) {
      console.error("Critical Worker Error:", err.message);
    }
    return new Response("OK");
  }
};

/**
 * مدیریت دانلود از لینک‌های مستقیم (مثل گیت‌هاب)
 */
async function handleLinkDownload(url, text, env, msg, statusId) {
  await editTg(env, msg.chat.id, statusId, "🌐 در حال اتصال به سرور مقصد (لینک خارجی)...");
  
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      },
      redirect: 'follow'
    });
  } catch (e) {
    throw new Error(`ارتباط با مقصد برقرار نشد (احتمالاً به دلیل تحریم یا فیلتر مقصد) - جزئیات: ${e.message}`);
  }

  if (!response.ok) throw new Error(`سرور مقصد پاسخ ناموفق داد (Status: ${response.status})`);
  
  const size = parseInt(response.headers.get("content-length") || "0");
  if (size > 50 * 1024 * 1024) throw new Error(`حجم فایل (${(size/1024/1024).toFixed(1)}MB) بیشتر از سقف ۵۰ مگابایت ورکر است.`);

  await editTg(env, msg.chat.id, statusId, "📥 در حال دریافت فایل (Download)...");
  const blob = await response.blob();

  let fileName = url.split('/').pop().split('?')[0] || "downloaded_file";
  if (url.toLowerCase().includes(".apk") || fileName.toLowerCase().endsWith(".apk")) {
    fileName = fileName.replace(/\.apk$/i, ".zip");
  }

  await editTg(env, msg.chat.id, statusId, "📤 در حال آپلود به بله...");
  await uploadToBale(env, blob, fileName, cleanText(text));
}

/**
 * مدیریت فایل‌های مستقیم تلگرام
 */
async function handleFileTransfer(file, text, env, msg, statusId) {
  await editTg(env, msg.chat.id, statusId, "🔍 در حال استخراج لینک فایل از تلگرام...");
  
  const tgFileRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`);
  const tgFileData = await tgFileRes.json();
  
  if (!tgFileData.ok) throw new Error("تلگرام اجازه دسترسی به فایل را نداد (احتمالاً فایل بالای ۲۰ مگابایت است).");

  const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;
  const fileName = tgFileData.result.file_path.split('/').pop();
  
  await editTg(env, msg.chat.id, statusId, "📥 در حال دانلود فایل از سرور تلگرام...");
  const fileRes = await fetch(fileUrl);
  const blob = await fileRes.blob();

  let finalName = fileName;
  if (fileName.toLowerCase().endsWith(".apk")) {
    finalName = fileName.replace(/\.apk$/i, ".zip");
  }

  await editTg(env, msg.chat.id, statusId, "📤 در حال آپلود به بله...");
  await uploadToBale(env, blob, finalName, cleanText(text));
}

/**
 * توابع کمکی (بدون تغییر)
 */
function cleanText(text) {
  return text.replace(/@[a-zA-Z0-9_]+/g, "").replace(/(https?:\/\/)?(t\.me|telegram\.me)\/[^\s]+/ig, "").trim();
}

function getFileData(m) {
  if (m.document) return { id: m.document.file_id, type: 'document' };
  if (m.photo) return { id: m.photo.pop().file_id, type: 'photo' };
  if (m.video) return { id: m.video.file_id, type: 'video' };
  if (m.audio) return { id: m.audio.file_id, type: 'audio' };
  return null;
}

async function uploadToBale(env, blob, name, cap) {
  const fd = new FormData();
  fd.append("chat_id", env.BALE_CHAT_ID);
  fd.append("document", blob, name);
  if (cap) fd.append("caption", cap.substring(0, 1024));

  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, { method: "POST", body: fd });
  const data = await res.json();
  if (!data.ok) throw new Error(`سایت بله فایل را نپذیرفت (Error: ${data.description})`);
}

async function sendToBale(env, method, payload) {
  return await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
}

async function sendTg(env, method, payload) {
  return await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function editTg(env, cId, mId, txt) {
  await sendTg(env, "editMessageText", { chat_id: cId, message_id: mId, text: txt });
}
