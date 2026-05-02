// استفاده از CDN برای حل مشکل بیلد و عدم نیاز به نصب پکیج
import JSZip from 'https://esm.sh/jszip@3.10.1';

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    try {
      const update = await request.json();
      
      // اگر پیام مستقیم آمد
      if (update.message) {
        await handleIncoming(update.message, env);
      } 
      // اگر روی دکمه شیشه‌ای کلیک شد
      else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error("Critical Error:", err.message);
    }

    return new Response("OK");
  }
};

// ۱. دریافت پیام و نمایش دکمه‌ها
async function handleIncoming(message, env) {
  if (String(message.from.id) !== String(env.ALLOWED_USER_ID)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 ارسال عادی (بدون @)", callback_data: "send_normal" }],
      [{ text: "🗜 ارسال به‌صورت Zip", callback_data: "send_zip" }],
      [{ text: "❌ لغو", callback_data: "send_cancel" }]
    ]
  };

  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text: "🛡 محتوا دریافت شد. نوع ارسال به بله را انتخاب کنید:\n(آیدی‌ها و لینک‌ها خودکار حذف می‌شوند)",
      reply_to_message_id: message.message_id,
      reply_markup: keyboard
    })
  });
}

// ۲. پردازش دکمه‌ها
async function handleCallback(cb, env) {
  const action = cb.data;
  const originalMsg = cb.message.reply_to_message;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  if (action === "send_cancel") {
    await editTgStatus(env, chatId, messageId, "❌ عملیات لغو شد.");
    return;
  }

  await editTgStatus(env, chatId, messageId, "⏳ در حال پردازش و ارسال...");

  try {
    let rawText = originalMsg.text || originalMsg.caption || "";
    // پاکسازی آیدی‌ها و لینک‌ها
    let safeText = rawText.replace(/@[a-zA-Z0-9_]+/g, "").replace(/(https?:\/\/)?t\.me\/[a-zA-Z0-9_]+/ig, "").trim();
    
    const file = getFileInfo(originalMsg);

    if (!file) {
      // اگر فقط متن بود
      await sendToBale(env, "sendMessage", { text: safeText || "پیام بدون متن" });
    } else {
      const tgFile = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`);
      const tgFileData = await tgFile.json();
      const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;

      if (action === "send_zip") {
        const fileBuffer = await (await fetch(fileUrl)).arrayBuffer();
        const zip = new JSZip();
        const fileName = tgFileData.result.file_path.split('/').pop();
        zip.file(fileName, fileBuffer);
        const zipContent = await zip.generateAsync({ type: "blob" });
        await uploadToBale(env, zipContent, fileName + ".zip", safeText);
      } else {
        const method = file.type === "photo" ? "sendPhoto" : file.type === "video" ? "sendVideo" : "sendDocument";
        await sendToBale(env, method, { [file.type]: fileUrl, caption: safeText });
      }
    }
    await editTgStatus(env, chatId, messageId, "✅ با موفقیت به بله ارسال شد.");
  } catch (error) {
    await editTgStatus(env, chatId, messageId, `❌ خطا: ${error.message}`);
  }
}

// توابع کمکی (Helpers)
function getFileInfo(msg) {
  if (msg.photo) return { id: msg.photo.pop().file_id, type: 'photo' };
  if (msg.video) return { id: msg.video.file_id, type: 'video' };
  if (msg.document) return { id: msg.document.file_id, type: 'document' };
  if (msg.audio) return { id: msg.audio.file_id, type: 'audio' };
  return null;
}

async function editTgStatus(env, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text })
  });
}

async function sendToBale(env, method, payload) {
  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
  return await res.json();
}

async function uploadToBale(env, blob, fileName, caption) {
  const formData = new FormData();
  formData.append("chat_id", env.BALE_CHAT_ID);
  formData.append("document", blob, fileName);
  formData.append("caption", caption);
  await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, { method: "POST", body: formData });
}
