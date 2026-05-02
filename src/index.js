// لود کردن کتابخانه زیپ از طریق CDN برای جلوگیری از ارور بیلد
import JSZip from 'https://esm.sh/jszip@3.10.1';

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    try {
      const update = await request.json();
      if (update.message) {
        await handleIncoming(update.message, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error("Error:", err.message);
    }
    return new Response("OK");
  }
};

async function handleIncoming(message, env) {
  if (String(message.from.id) !== String(env.ALLOWED_USER_ID)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 ارسال عادی (بدون @)", callback_data: "mode_safe" }],
      [{ text: "🗜 ارسال به‌صورت زیپ", callback_data: "mode_zip" }],
      [{ text: "❌ لغو", callback_data: "mode_cancel" }]
    ]
  };

  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text: "🤖 پیام دریافت شد. نحوه انتقال به بله را انتخاب کنید:",
      reply_to_message_id: message.message_id,
      reply_markup: keyboard
    })
  });
}

async function handleCallback(cb, env) {
  const action = cb.data;
  const originalMsg = cb.message.reply_to_message;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  if (action === "mode_cancel") {
    await editStatus(env, chatId, messageId, "❌ عملیات لغو شد.");
    return;
  }

  await editStatus(env, chatId, messageId, "⏳ در حال پردازش و ارسال...");

  try {
    let rawText = originalMsg.text || originalMsg.caption || "";
    // حذف آیدی‌ها و لینک‌ها
    let safeText = rawText.replace(/@[a-zA-Z0-9_]+/g, "").replace(/(https?:\/\/)?t\.me\/[a-zA-Z0-9_]+/ig, "").trim();
    
    const file = getFile(originalMsg);

    if (!file) {
      await sendBale(env, "sendMessage", { text: safeText || "پیام متنی" });
    } else {
      const tgFile = await (await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`)).json();
      const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFile.result.file_path}`;

      if (action === "mode_zip") {
        const fileBuffer = await (await fetch(fileUrl)).arrayBuffer();
        const zip = new JSZip();
        const fileName = tgFile.result.file_path.split('/').pop();
        zip.file(fileName, fileBuffer);
        const zipContent = await zip.generateAsync({ type: "blob" });
        await uploadBale(env, zipContent, fileName + ".zip", safeText);
      } else {
        const method = file.type === "photo" ? "sendPhoto" : file.type === "video" ? "sendVideo" : "sendDocument";
        await sendBale(env, method, { [file.type]: fileUrl, caption: safeText });
      }
    }
    await editStatus(env, chatId, messageId, "✅ با موفقیت به بله منتقل شد.");
  } catch (e) {
    await editStatus(env, chatId, messageId, `❌ خطا: ${e.message}`);
  }
}

// توابع کمکی
function getFile(m) {
  if (m.photo) return { id: m.photo.pop().file_id, type: 'photo' };
  if (m.video) return { id: m.video.file_id, type: 'video' };
  if (m.document) return { id: m.document.file_id, type: 'document' };
  return null;
}

async function editStatus(env, cId, mId, txt) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: cId, message_id: mId, text: txt })
  });
}

async function sendBale(env, method, payload) {
  await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
}

async function uploadBale(env, blob, name, cap) {
  const fd = new FormData();
  fd.append("chat_id", env.BALE_CHAT_ID);
  fd.append("document", blob, name);
  fd.append("caption", cap);
  await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, { method: "POST", body: fd });
}
