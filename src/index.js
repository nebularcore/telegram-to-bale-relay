/**
 * PROJECT: TG-TO-BALE RELAY (SECURITY & AUTOMATION OPTIMIZED)
 * 4 ENV VARS REQUIRED: TG_TOKEN, BALE_TOKEN, BALE_CHAT_ID, ALLOWED_USER_ID
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    try {
      const update = await request.json();
      if (!update.message) return new Response("OK");

      const msg = update.message;

      // 1. امنیت: چک کردن آیدی کاربر (Strict Security)
      if (String(msg.from.id) !== String(env.ALLOWED_USER_ID)) {
        return new Response("Unauthorized Access", { status: 403 });
      }

      const file = getFileData(msg);
      // 2. متن جایگزین در صورت خالی بودن پیام
      let rawText = msg.text || msg.caption || "";
      if (!rawText.trim()) {
        rawText = "📎 محتوای ارسالی بدون توضیح"; 
      }

      const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);

      // اطلاع‌رسانی به کاربر تلگرام
      const status = await sendTg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: "⏳ در حال پردازش و انتقال خودکار...",
        reply_to_message_id: msg.message_id
      });
      const statusData = await status.json();
      const statusId = statusData.result?.message_id;

      // --- پردازش اصلی (بدون نیاز به انتخاب منو برای جلوگیری از مشکل نت) ---
      try {
        if (!file && urlMatch) {
          // اگر لینک مستقیم بود
          await handleLinkDownload(urlMatch[0], rawText, env);
        } else if (file) {
          // اگر فایل مستقیم تلگرامی بود
          await handleFileTransfer(file, rawText, env);
        } else {
          // اگر فقط متن بود
          await sendToBale(env, "sendMessage", { text: cleanText(rawText) });
        }

        if (statusId) await editTg(env, msg.chat.id, statusId, "✅ با موفقیت منتقل شد.");
      } catch (err) {
        if (statusId) await editTg(env, msg.chat.id, statusId, `❌ خطا: ${err.message}`);
      }

    } catch (err) {
      console.error("Critical Error:", err.message);
    }
    return new Response("OK");
  }
};

/**
 * مدیریت انتقال فایل‌های مستقیم تلگرام
 */
async function handleFileTransfer(file, text, env) {
  const tgFileRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`);
  const tgFileData = await tgFileRes.json();
  if (!tgFileData.ok) throw new Error("فایل در تلگرام یافت نشد یا بسیار حجیم است.");

  const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;
  const fileName = tgFileData.result.file_path.split('/').pop();
  
  const fileRes = await fetch(fileUrl);
  const blob = await fileRes.blob();

  // امنیت و بای‌پس APK: تغییر نام خودکار برای جلوگیری از بلاک بله
  let finalName = fileName;
  if (fileName.toLowerCase().endsWith(".apk")) {
    finalName = fileName.replace(/\.apk$/i, ".zip");
  }

  await uploadToBale(env, blob, finalName, cleanText(text));
}

/**
 * دانلود از لینک‌های مستقیم (GitHub/Web)
 */
async function handleLinkDownload(url, text, env) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("لینک دانلود معتبر نیست.");
  
  const size = parseInt(response.headers.get("content-length") || "0");
  if (size > 50 * 1024 * 1024) throw new Error("حجم فایل بالای ۵۰ مگابایت است.");

  const blob = await response.blob();
  let fileName = url.split('/').pop().split('?')[0] || "file_download";
  
  if (url.toLowerCase().includes(".apk") || fileName.toLowerCase().endsWith(".apk")) {
    fileName = fileName.replace(/\.apk$/i, ".zip");
  }
  if (!fileName.includes('.')) fileName += ".dat";

  await uploadToBale(env, blob, fileName, cleanText(text));
}

// --- ابزارهای کمکی ---

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
  if (!data.ok) throw new Error(data.description);
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
