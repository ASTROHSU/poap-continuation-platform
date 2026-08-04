import type { Bindings } from "./types";

export interface MagicLinkMessage {
  challengeId: string;
  email: string;
  magicLink: string;
  purpose: "reserve" | "login";
  eventTitle?: string;
}

export interface MagicLinkEmailContent {
  subject: string;
  text: string;
  html: string;
}

export async function sendMagicLinkEmail(
  env: Pick<Bindings, "EMAIL_PROVIDER" | "EMAIL_FROM" | "RESEND_API_KEY" | "PUBLIC_APP_URL">,
  message: MagicLinkMessage,
): Promise<void> {
  if (env.EMAIL_PROVIDER === "console") {
    if (!mayExposeDevelopmentMagicLink(env)) {
      throw new Error("Console email delivery is allowed only in local or test environments.");
    }
    console.log("Development magic link created", {
      challengeId: message.challengeId,
      purpose: message.purpose,
      magicLink: message.magicLink,
    });
    return;
  }
  if (env.EMAIL_PROVIDER !== "resend" || !env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error("Production email delivery is not configured.");
  }

  const content = buildMagicLinkEmail(message);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `magic-link/${message.challengeId}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.email],
      subject: content.subject,
      text: content.text,
      html: content.html,
    }),
  });
  if (!response.ok) {
    throw new Error(`Email provider rejected the request (${response.status}).`);
  }
}

export function buildMagicLinkEmail(message: MagicLinkMessage): MagicLinkEmailContent {
  const isReservation = message.purpose === "reserve";
  const eventTitle = message.eventTitle?.trim() || "數位紀念";
  const subject = isReservation ? `確認保留：${eventTitle}` : "登入你的 POAP 收藏";
  const eyebrow = isReservation ? "活動紀念 · EMAIL 確認" : "COLLECTORS · EMAIL 登入";
  const title = isReservation ? "確認保留這份共同記憶" : "回到你的 POAP 收藏";
  const intro = isReservation
    ? "你正在為一段值得記住的共同經歷保留數位紀念。"
    : "你的收藏已經準備好了。完成驗證後，就能繼續查看每一次共同經歷。";
  const action = isReservation ? "確認保留名額" : "登入 Email 收藏";
  const detailLabel = isReservation ? "本次活動" : "你的收藏";
  const detailValue = isReservation ? eventTitle : "歷史 POAP ＋ 新活動紀念";
  const safeLink = escapeHtml(message.magicLink);
  const safeEventTitle = escapeHtml(eventTitle);

  const text = isReservation
    ? `${title}\n\n${detailLabel}：${eventTitle}\n\n${action}：${message.magicLink}\n\n這個安全連結將在 15 分鐘後失效，且只能使用一次。若你沒有提出這項操作，可以忽略這封信。\n\n兆量富足教育協會 · POAP 留存計畫`
    : `${title}\n\n${intro}\n\n${action}：${message.magicLink}\n\n這個安全連結將在 15 分鐘後失效，且只能使用一次。若你沒有提出這項操作，可以忽略這封信。\n\n兆量富足教育協會 · POAP 留存計畫`;

  const html = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f4ff;color:#2f2a47;font-family:'Noto Sans TC','PingFang TC','Microsoft JhengHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(intro)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f5f4ff;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding:0 8px 20px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="58" valign="middle">
                      <div style="width:46px;height:46px;border:2px dashed #b5aeff;border-radius:15px;background:#ffffff;color:#7c72e2;font-size:22px;font-weight:900;line-height:46px;text-align:center;box-shadow:5px 5px 0 #dddaff;">P</div>
                    </td>
                    <td valign="middle">
                      <div style="font-size:16px;font-weight:900;letter-spacing:.02em;color:#2f2a47;">POAP 留存計畫</div>
                      <div style="margin-top:3px;font-size:11px;font-weight:700;letter-spacing:.05em;color:#8a85a3;">歷史 Archive＋新收藏</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="border:2px solid #2f2a47;border-radius:28px;background:#ffffff;box-shadow:10px 10px 0 #dddaff;overflow:hidden;">
                <div style="height:12px;background:#7c72e2;border-radius:26px 26px 0 0;"></div>
                <div style="padding:42px 42px 38px;">
                  <div style="font-size:11px;font-weight:900;letter-spacing:.14em;color:#986fa8;">${escapeHtml(eyebrow)}</div>
                  <h1 style="margin:18px 0 0;font-size:34px;line-height:1.28;letter-spacing:-.04em;color:#2f2a47;font-weight:900;">${escapeHtml(title)}</h1>
                  <p style="margin:18px 0 0;font-size:16px;line-height:1.8;color:#6f6988;">${escapeHtml(intro)}</p>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;border-collapse:separate;">
                    <tr>
                      <td style="border-radius:18px;background:#f5f4ff;padding:18px 20px;border:1px solid #e4e1ff;">
                        <div style="font-size:11px;font-weight:900;letter-spacing:.1em;color:#986fa8;">${escapeHtml(detailLabel)}</div>
                        <div style="margin-top:7px;font-size:17px;font-weight:900;line-height:1.45;color:#2f2a47;">${isReservation ? safeEventTitle : escapeHtml(detailValue)}</div>
                      </td>
                    </tr>
                  </table>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
                    <tr>
                      <td align="center" bgcolor="#7c72e2" style="border:2px solid #2f2a47;border-radius:999px;box-shadow:0 6px 0 #5e58a5;">
                        <a href="${safeLink}" style="display:block;padding:17px 26px;color:#ffffff;text-decoration:none;font-size:17px;font-weight:900;line-height:1.2;">${escapeHtml(action)} →</a>
                      </td>
                    </tr>
                  </table>
                  <div style="margin-top:30px;border-top:1px solid #e4e1ff;padding-top:22px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td width="38" valign="top">
                          <div style="width:28px;height:28px;border-radius:50%;background:#d8f2c8;color:#4b7a3a;font-size:15px;font-weight:900;line-height:28px;text-align:center;">✓</div>
                        </td>
                        <td style="font-size:13px;line-height:1.75;color:#7d7794;">
                          這個安全連結將在 <strong style="color:#2f2a47;">15 分鐘</strong>後失效，且只能使用一次。若你沒有提出這項操作，可以直接忽略這封信。
                        </td>
                      </tr>
                    </table>
                  </div>
                  <p style="margin:22px 0 0;font-size:11px;line-height:1.7;color:#9a95ad;word-break:break-all;">按鈕無法開啟時，請複製這個連結：<br /><a href="${safeLink}" style="color:#5e58a5;text-decoration:underline;">${safeLink}</a></p>
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 18px 8px;font-size:12px;line-height:1.75;color:#8a85a3;">
                <strong style="color:#5e58a5;">兆量富足教育協會</strong><br />
                記憶留下，故事繼續。
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

export function mayExposeDevelopmentMagicLink(
  env: Pick<Bindings, "EMAIL_PROVIDER" | "PUBLIC_APP_URL">,
) {
  if (env.EMAIL_PROVIDER !== "console") return false;
  try {
    const hostname = new URL(env.PUBLIC_APP_URL).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".test");
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
